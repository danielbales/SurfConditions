import Foundation
import Combine

@MainActor
class SurfDataService: ObservableObject {
    @Published var swellData: SwellData?
    @Published var windData: WindData?
    @Published var tideData: TideData?
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var lastUpdated: Date?

    // Published properties
    @Published var buoyData: BuoyObservation?
    @Published var sunData: SunData?
    @Published var marineForecast: [NWSForecastPeriod] = []
    @Published var ripCurrentRisk: String = "Unknown"
    @Published var ripCurrentDetail: String?
    @Published var uvIndex: Double?
    @Published var moonPhase: MoonPhaseData = .current()

    // New properties
    @Published var selectedLocation: SurfLocation = SurfLocation.all[0]
    @Published var hourlyForecast: [HourlyDataPoint] = []
    @Published var surfQuality: SurfQuality = SurfQuality(label: "--", score: 0)

    private var lat: Double { selectedLocation.lat }
    private var lon: Double { selectedLocation.lon }

    func selectLocation(_ location: SurfLocation) {
        selectedLocation = location
        loadCache()
        Task { await fetchAll() }
    }

    func fetchAll() async {
        isLoading = true
        errorMessage = nil

        // Compute moon phase locally (no network needed)
        moonPhase = .current()

        async let marine   = fetchMarine()
        async let weather  = fetchWeather()
        async let tides    = fetchTides()
        async let buoy     = fetchBuoy()
        async let sun      = fetchSunrise()
        async let forecast = fetchMarineForecast()
        async let alerts   = fetchAlerts()
        async let hourly   = fetchHourlyMarine()

        let (m, w, t, b, s, f, a, h) = await (marine, weather, tides, buoy, sun, forecast, alerts, hourly)

        swellData      = m
        windData       = w?.wind
        uvIndex        = w?.uvIndex
        tideData       = t
        buoyData       = b
        sunData        = s
        marineForecast = f ?? []
        hourlyForecast = h ?? []
        parseRipCurrentRisk(from: a)

        surfQuality = SurfQuality.evaluate(swell: swellData, wind: windData, beachFacing: selectedLocation.beachFacing)

        isLoading   = false
        lastUpdated = Date()

        saveCache()
    }

    // MARK: - Marine (wave/swell)

    private func fetchMarine() async -> SwellData? {
        let vars = "wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period"
        let urlStr = "https://marine-api.open-meteo.com/v1/marine?latitude=\(lat)&longitude=\(lon)&current=\(vars)&timezone=America/Los_Angeles"
        guard let url = URL(string: urlStr) else { return nil }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let resp = try JSONDecoder().decode(MarineAPIResponse.self, from: data)
            let c = resp.current
            let mToFt = 3.28084

            return SwellData(
                waveHeight:    (c.waveHeight    ?? 0) * mToFt,
                wavePeriod:     c.wavePeriod    ?? 0,
                waveDirection:  c.waveDirection ?? 0,
                swellHeight:   (c.swellWaveHeight    ?? 0) * mToFt,
                swellPeriod:    c.swellWavePeriod    ?? 0,
                swellDirection: c.swellWaveDirection ?? 0
            )
        } catch {
            errorMessage = "Wave data unavailable"
            return nil
        }
    }

    // MARK: - Weather (wind + UV index)

    private func fetchWeather() async -> WeatherFetchResult? {
        let vars = "wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index"
        let urlStr = "https://api.open-meteo.com/v1/forecast?latitude=\(lat)&longitude=\(lon)&current=\(vars)&wind_speed_unit=mph&timezone=America/Los_Angeles"
        guard let url = URL(string: urlStr) else { return nil }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let resp = try JSONDecoder().decode(WeatherAPIResponse.self, from: data)
            let c = resp.current

            let wind = WindData(
                speed:     c.windSpeed10m     ?? 0,
                direction: c.windDirection10m ?? 0,
                gusts:     c.windGusts10m     ?? 0
            )
            return WeatherFetchResult(wind: wind, uvIndex: c.uvIndex ?? 0)
        } catch {
            if errorMessage == nil { errorMessage = "Wind data unavailable" }
            return nil
        }
    }

    // MARK: - NOAA Tides

    private func fetchTides() async -> TideData? {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyyMMdd"
        fmt.timeZone = TimeZone(identifier: "America/Los_Angeles")
        let today    = fmt.string(from: Date())
        let tomorrow = fmt.string(from: Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())

        let station = selectedLocation.tideStation
        let urlStr = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter" +
            "?begin_date=\(today)&end_date=\(tomorrow)" +
            "&station=\(station)&product=predictions&datum=MLLW" +
            "&time_zone=lst_ldt&interval=hilo&units=english" +
            "&application=surf_conditions&format=json"

        guard let url = URL(string: urlStr) else { return nil }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let resp = try JSONDecoder().decode(NOAATideAPIResponse.self, from: data)
            if let preds = resp.predictions {
                return TideData(predictions: preds)
            }
            if errorMessage == nil { errorMessage = "Tide data unavailable" }
            return nil
        } catch {
            if errorMessage == nil { errorMessage = "Tide data unavailable" }
            return nil
        }
    }

    // MARK: - NDBC Buoy (tab-delimited text)

    private func fetchBuoy() async -> BuoyObservation? {
        let buoyId = selectedLocation.buoyStation
        guard let url = URL(string: "https://www.ndbc.noaa.gov/data/realtime2/\(buoyId).txt") else { return nil }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let text = String(data: data, encoding: .utf8) else { return nil }

            let lines = text.components(separatedBy: .newlines)
            // Skip comment/header lines (starting with #), collect data lines
            let dataLines = lines.filter { !$0.hasPrefix("#") && !$0.trimmingCharacters(in: .whitespaces).isEmpty }

            guard let firstLine = dataLines.first else { return nil }

            let cols = firstLine.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
            guard cols.count >= 15 else { return nil }

            // Column layout (0-based):
            // 0=YY, 1=MM, 2=DD, 3=hh, 4=mm
            // 5=WDIR, 6=WSPD(m/s), 7=GST, 8=WVHT(m), 9=DPD, 10=APD, 11=MWD, 14=WTMP(°C)
            func val(_ line: [String], _ i: Int) -> Double? {
                guard i < line.count else { return nil }
                let s = line[i]
                if s == "MM" { return nil }
                return Double(s)
            }

            let wdir  = val(cols, 5) ?? 0
            let wspd  = (val(cols, 6) ?? 0) * 2.23694   // m/s → mph
            let wvht  = (val(cols, 8) ?? 0) * 3.28084   // m → ft
            let dpd   = val(cols, 9) ?? 0
            let apd   = val(cols, 10) ?? 0
            let mwd   = val(cols, 11) ?? 0
            let wtmpC = val(cols, 14) ?? 0
            let wtmpF = wtmpC * 9.0 / 5.0 + 32.0

            // Parse observation time from cols 0-4 as UTC
            var dc = DateComponents()
            dc.timeZone = TimeZone(identifier: "UTC")
            if let yr = Int(cols[0]) { dc.year  = yr < 100 ? 2000 + yr : yr }
            if let mo = Int(cols[1]) { dc.month  = mo }
            if let dy = Int(cols[2]) { dc.day    = dy }
            if let hr = Int(cols[3]) { dc.hour   = hr }
            if let mn = Int(cols[4]) { dc.minute = mn }
            let observedAt = Calendar(identifier: .gregorian).date(from: dc)

            // Collect recent wave heights from next 11 rows (rows are newest-first, so reverse for oldest→newest)
            var recentHeights: [Double] = []
            for line in dataLines.prefix(12) {
                let lCols = line.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
                if let h = val(lCols, 8), h > 0 {
                    recentHeights.append(h * 3.28084)
                }
            }
            recentHeights = recentHeights.reversed()

            return BuoyObservation(
                waveHeight:     wvht,
                dominantPeriod: dpd,
                avgPeriod:      apd,
                waveDirection:  mwd,
                waterTemp:      wtmpF,
                windSpeed:      wspd,
                windDirection:  wdir,
                observedAt:     observedAt,
                recentWaveHeights: recentHeights
            )
        } catch {
            return nil
        }
    }

    // MARK: - Sunrise / Sunset

    private func fetchSunrise() async -> SunData? {
        let urlStr = "https://api.sunrise-sunset.org/json?lat=\(lat)&lng=\(lon)&formatted=0"
        guard let url = URL(string: urlStr) else { return nil }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let resp = try JSONDecoder().decode(SunriseSunsetAPIResponse.self, from: data)
            guard resp.status == "OK" else { return nil }

            let isoFormatter = ISO8601DateFormatter()
            isoFormatter.formatOptions = [.withInternetDateTime]

            guard
                let firstLight = isoFormatter.date(from: resp.results.civilTwilightBegin),
                let sunrise    = isoFormatter.date(from: resp.results.sunrise),
                let sunset     = isoFormatter.date(from: resp.results.sunset),
                let lastLight  = isoFormatter.date(from: resp.results.civilTwilightEnd)
            else { return nil }

            return SunData(
                firstLight:              firstLight,
                sunrise:                 sunrise,
                goldenHourMorningEnd:    sunrise.addingTimeInterval(3600),
                sunset:                  sunset,
                goldenHourEveningBegin:  sunset.addingTimeInterval(-3600),
                lastLight:               lastLight
            )
        } catch {
            return nil
        }
    }

    // MARK: - NWS Marine Forecast (CWF text product)

    private func fetchMarineForecast() async -> [NWSForecastPeriod]? {
        guard let listURL = URL(string: "https://api.weather.gov/products/types/CWF/locations/MTR") else { return nil }
        var listReq = URLRequest(url: listURL)
        listReq.setValue("SurfConditionsApp/1.0", forHTTPHeaderField: "User-Agent")
        listReq.setValue("application/geo+json", forHTTPHeaderField: "Accept")

        do {
            let (listData, _) = try await URLSession.shared.data(for: listReq)
            guard
                let json = try JSONSerialization.jsonObject(with: listData) as? [String: Any],
                let graph = json["@graph"] as? [[String: Any]],
                let firstID = graph.first?["id"] as? String
            else { return nil }

            guard let prodURL = URL(string: "https://api.weather.gov/products/\(firstID)") else { return nil }
            var prodReq = URLRequest(url: prodURL)
            prodReq.setValue("SurfConditionsApp/1.0", forHTTPHeaderField: "User-Agent")

            let (prodData, _) = try await URLSession.shared.data(for: prodReq)
            guard
                let prodJSON = try JSONSerialization.jsonObject(with: prodData) as? [String: Any],
                let fullText = prodJSON["productText"] as? String
            else { return nil }

            return parseCWFSection(from: fullText, zone: selectedLocation.marineZone)
        } catch {
            return nil
        }
    }

    private func parseCWFSection(from text: String, zone: String) -> [NWSForecastPeriod]? {
        guard let zoneRange = text.range(of: zone + "-") else { return nil }

        let afterZone = text[zoneRange.upperBound...]
        let sectionLines = afterZone.components(separatedBy: "\n")

        var body: [String] = []
        for line in sectionLines {
            if line.hasPrefix("$$") { break }
            body.append(line)
        }

        let trimmed = body
            .dropFirst(3)
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmed.isEmpty else { return nil }

        let descLine = sectionLines.first?.trimmingCharacters(in: .whitespacesAndNewlines)
                        .replacingOccurrences(of: "-", with: "") ?? zone

        return [NWSForecastPeriod(number: 1, name: descLine, shortForecast: nil, detailedForecast: trimmed)]
    }

    // MARK: - NWS Alerts (rip current risk)

    private func fetchAlerts() async -> [NWSAlertProperties]? {
        guard let url = URL(string: "https://api.weather.gov/alerts/active?point=\(lat),\(lon)") else { return nil }

        var request = URLRequest(url: url)
        request.setValue("SurfConditionsApp/1.0", forHTTPHeaderField: "User-Agent")
        request.setValue("application/geo+json", forHTTPHeaderField: "Accept")

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let resp = try JSONDecoder().decode(NWSAlertsResponse.self, from: data)
            return resp.features.map { $0.properties }
        } catch {
            return nil
        }
    }

    private func parseRipCurrentRisk(from alerts: [NWSAlertProperties]?) {
        guard let alerts = alerts, !alerts.isEmpty else {
            ripCurrentRisk   = "Low"
            ripCurrentDetail = nil
            return
        }

        for alert in alerts {
            let ev = alert.event.lowercased()
            if ev.contains("rip current") {
                let sev = alert.severity?.lowercased() ?? ""
                ripCurrentRisk   = (sev == "extreme" || sev == "severe") ? "High" : "Moderate"
                ripCurrentDetail = alert.headline
                return
            }
        }
        for alert in alerts {
            let ev = alert.event.lowercased()
            if ev.contains("high surf") {
                ripCurrentRisk   = "High"
                ripCurrentDetail = alert.headline
                return
            }
        }

        ripCurrentRisk   = "Low"
        ripCurrentDetail = nil
    }

    // MARK: - Hourly Marine Forecast

    private func fetchHourlyMarine() async -> [HourlyDataPoint]? {
        let vars = "wave_height,swell_wave_height,wind_wave_height,wave_period"
        let urlStr = "https://marine-api.open-meteo.com/v1/marine?latitude=\(lat)&longitude=\(lon)&hourly=\(vars)&forecast_days=3&timezone=America/Los_Angeles"
        guard let url = URL(string: urlStr) else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let resp = try JSONDecoder().decode(MarineHourlyResponse.self, from: data)
            let h = resp.hourly
            let fmt = DateFormatter()
            fmt.dateFormat = "yyyy-MM-dd'T'HH:mm"
            fmt.timeZone = TimeZone(identifier: "America/Los_Angeles")
            let now = Date()
            let mToFt = 3.28084
            var points: [HourlyDataPoint] = []
            for i in 0..<h.time.count {
                guard let date = fmt.date(from: h.time[i]),
                      date >= now,
                      date <= now.addingTimeInterval(48 * 3600)
                else { continue }
                points.append(HourlyDataPoint(
                    time: date,
                    waveHeightFt: (h.waveHeight[i] ?? 0) * mToFt,
                    swellHeightFt: (h.swellWaveHeight[i] ?? 0) * mToFt,
                    windWaveHeightFt: (h.windWaveHeight[i] ?? 0) * mToFt,
                    wavePeriod: h.wavePeriod[i] ?? 0
                ))
            }
            return points
        } catch { return nil }
    }

    // MARK: - Cache

    func saveCache() {
        let cache = SurfCache(
            locationId: selectedLocation.id,
            timestamp: Date(),
            swellData: swellData,
            windData: windData,
            buoyData: buoyData,
            tideData: tideData,
            uvIndex: uvIndex,
            sunData: sunData,
            hourlyForecast: hourlyForecast,
            marineForecast: marineForecast,
            ripCurrentRisk: ripCurrentRisk,
            ripCurrentDetail: ripCurrentDetail
        )
        if let encoded = try? JSONEncoder().encode(cache) {
            UserDefaults.standard.set(encoded, forKey: "surf_cache_\(selectedLocation.id)")
        }
    }

    func loadCache() {
        guard let data = UserDefaults.standard.data(forKey: "surf_cache_\(selectedLocation.id)"),
              let cache = try? JSONDecoder().decode(SurfCache.self, from: data)
        else { return }
        swellData        = cache.swellData
        windData         = cache.windData
        buoyData         = cache.buoyData
        tideData         = cache.tideData
        uvIndex          = cache.uvIndex
        sunData          = cache.sunData
        hourlyForecast   = cache.hourlyForecast
        marineForecast   = cache.marineForecast
        ripCurrentRisk   = cache.ripCurrentRisk
        ripCurrentDetail = cache.ripCurrentDetail
        lastUpdated      = cache.timestamp
        surfQuality = SurfQuality.evaluate(swell: swellData, wind: windData, beachFacing: selectedLocation.beachFacing)
    }

    // MARK: - Auto-Refresh

    func startAutoRefresh() {
        Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                await self?.fetchAll()
            }
        }
    }
}
