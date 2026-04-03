import Foundation

// MARK: - Open-Meteo Marine API

struct MarineAPIResponse: Codable {
    let current: MarineCurrent
}

struct MarineCurrent: Codable {
    let time: String
    let waveHeight: Double?
    let waveDirection: Double?
    let wavePeriod: Double?
    let swellWaveHeight: Double?
    let swellWaveDirection: Double?
    let swellWavePeriod: Double?

    enum CodingKeys: String, CodingKey {
        case time
        case waveHeight = "wave_height"
        case waveDirection = "wave_direction"
        case wavePeriod = "wave_period"
        case swellWaveHeight = "swell_wave_height"
        case swellWaveDirection = "swell_wave_direction"
        case swellWavePeriod = "swell_wave_period"
    }
}

// MARK: - Open-Meteo Hourly Marine API

struct MarineHourlyResponse: Codable {
    let hourly: MarineHourlyData
}

struct MarineHourlyData: Codable {
    let time: [String]
    let waveHeight: [Double?]
    let swellWaveHeight: [Double?]
    let windWaveHeight: [Double?]
    let wavePeriod: [Double?]
    enum CodingKeys: String, CodingKey {
        case time
        case waveHeight = "wave_height"
        case swellWaveHeight = "swell_wave_height"
        case windWaveHeight = "wind_wave_height"
        case wavePeriod = "wave_period"
    }
}

// MARK: - Open-Meteo Weather API

struct WeatherAPIResponse: Codable {
    let current: WeatherCurrent
}

struct WeatherCurrent: Codable {
    let time: String
    let windSpeed10m: Double?
    let windDirection10m: Double?
    let windGusts10m: Double?
    let uvIndex: Double?

    enum CodingKeys: String, CodingKey {
        case time
        case windSpeed10m = "wind_speed_10m"
        case windDirection10m = "wind_direction_10m"
        case windGusts10m = "wind_gusts_10m"
        case uvIndex = "uv_index"
    }
}

// MARK: - NOAA Tides API

struct NOAATideAPIResponse: Codable {
    let predictions: [NOAATidePrediction]?
    let error: NOAAErrorResponse?
}

struct NOAAErrorResponse: Codable {
    let message: String
}

struct NOAATidePrediction: Codable, Identifiable {
    let t: String   // "YYYY-MM-DD HH:MM"
    let v: String   // feet
    let type: String // "H" or "L"

    var id: String { t }

    var heightFeet: Double { Double(v) ?? 0 }

    var date: Date? {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        f.timeZone = TimeZone(identifier: "America/Los_Angeles")
        return f.date(from: t)
    }

    var formattedTime: String {
        guard let d = date else { return t }
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        f.timeZone = TimeZone(identifier: "America/Los_Angeles")
        return f.string(from: d)
    }

    var isHigh: Bool { type == "H" }
    var isFuture: Bool { (date ?? .distantPast) > Date() }
    var isToday: Bool {
        guard let d = date else { return false }
        var cal = Calendar.current
        cal.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return cal.isDateInToday(d)
    }
}

// MARK: - Domain Models

struct SwellData: Codable {
    let waveHeight: Double   // feet
    let wavePeriod: Double   // seconds
    let waveDirection: Double // degrees
    let swellHeight: Double  // feet
    let swellPeriod: Double  // seconds
    let swellDirection: Double // degrees
}

struct WindData: Codable {
    let speed: Double     // mph
    let direction: Double // degrees
    let gusts: Double     // mph
}

struct TideData {
    let predictions: [NOAATidePrediction]

    var futurePredictions: [NOAATidePrediction] {
        predictions.filter { $0.isFuture }.sorted { ($0.date ?? .distantPast) < ($1.date ?? .distantPast) }
    }

    var todayPredictions: [NOAATidePrediction] {
        predictions.filter { $0.isToday }.sorted { ($0.date ?? .distantPast) < ($1.date ?? .distantPast) }
    }

    var nextHigh: NOAATidePrediction? { futurePredictions.first { $0.isHigh } }
    var nextLow: NOAATidePrediction?  { futurePredictions.first { !$0.isHigh } }
    var isRising: Bool?               { futurePredictions.first.map { $0.isHigh } }
}

extension TideData: Codable {
    enum CodingKeys: String, CodingKey { case predictions }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        predictions = try c.decode([NOAATidePrediction].self, forKey: .predictions)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(predictions, forKey: .predictions)
    }
}

// MARK: - NEW: Internal transfer type for weather fetch

struct WeatherFetchResult: Codable {
    let wind: WindData
    let uvIndex: Double
}

// MARK: - NEW: NDBC Buoy Observation

struct BuoyObservation: Codable {
    let waveHeight: Double       // feet (converted from meters)
    let dominantPeriod: Double   // seconds
    let avgPeriod: Double        // seconds
    let waveDirection: Double    // degrees
    let waterTemp: Double        // °F (converted from °C)
    let windSpeed: Double        // mph (converted from m/s)
    let windDirection: Double    // degrees
    let observedAt: Date?
    var recentWaveHeights: [Double]
}

// MARK: - NEW: Sun Data

struct SunData: Codable {
    let firstLight: Date              // civil twilight begin
    let sunrise: Date
    let goldenHourMorningEnd: Date    // sunrise + 1hr
    let sunset: Date
    let goldenHourEveningBegin: Date  // sunset - 1hr
    let lastLight: Date               // civil twilight end
}

// MARK: - NEW: Sunrise-sunset.org API response

struct SunriseSunsetAPIResponse: Codable {
    let results: SunriseSunsetResults
    let status: String
}

struct SunriseSunsetResults: Codable {
    let sunrise: String
    let sunset: String
    let civilTwilightBegin: String
    let civilTwilightEnd: String

    enum CodingKeys: String, CodingKey {
        case sunrise, sunset
        case civilTwilightBegin = "civil_twilight_begin"
        case civilTwilightEnd   = "civil_twilight_end"
    }
}

// MARK: - NEW: NWS Zone Forecast

struct NWSZoneForecastResponse: Codable {
    let properties: NWSZoneForecastProperties
}

struct NWSZoneForecastProperties: Codable {
    let updated: String?
    let periods: [NWSForecastPeriod]
}

struct NWSForecastPeriod: Codable {
    let number: Int
    let name: String
    let shortForecast: String?
    let detailedForecast: String
}

// MARK: - NEW: NWS Alerts (GeoJSON FeatureCollection)

struct NWSAlertsResponse: Codable {
    let features: [NWSAlertFeature]
}

struct NWSAlertFeature: Codable {
    let properties: NWSAlertProperties
}

struct NWSAlertProperties: Codable {
    let event: String
    let headline: String?
    let severity: String?
}

// MARK: - NEW: Moon Phase (computed locally, no API)

struct MoonPhaseData: Codable {
    let phase: Double          // 0-1 (0=new, 0.5=full)
    let name: String
    let emoji: String
    let illumination: Double   // 0-1
    let tidalNote: String

    static func current() -> MoonPhaseData {
        // Known new moon: Jan 6 2000 18:14 UTC
        let knownNewMoon: Double = 947182440.0
        let synodic: Double = 29.53058867 * 86400.0
        var p = (Date().timeIntervalSince1970 - knownNewMoon).truncatingRemainder(dividingBy: synodic) / synodic
        if p < 0 { p += 1 }
        let illum = (1.0 - cos(2.0 * .pi * p)) / 2.0

        let name: String
        let emoji: String
        switch p {
        case 0..<0.025:
            (name, emoji) = ("New Moon", "🌑")
        case 0.025..<0.25:
            (name, emoji) = ("Waxing Crescent", "🌒")
        case 0.25..<0.275:
            (name, emoji) = ("First Quarter", "🌓")
        case 0.275..<0.475:
            (name, emoji) = ("Waxing Gibbous", "🌔")
        case 0.475..<0.525:
            (name, emoji) = ("Full Moon", "🌕")
        case 0.525..<0.725:
            (name, emoji) = ("Waning Gibbous", "🌖")
        case 0.725..<0.75:
            (name, emoji) = ("Last Quarter", "🌗")
        case 0.975..<1.0:
            (name, emoji) = ("New Moon", "🌑")
        default:
            (name, emoji) = ("Waning Crescent", "🌘")
        }

        let springOrNeap = (p < 0.1 || p > 0.9 || (p > 0.4 && p < 0.6))
        let tidalNote = springOrNeap ? "Spring tides — larger tidal range" : "Neap tides — smaller tidal range"

        return MoonPhaseData(phase: p, name: name, emoji: emoji, illumination: illum, tidalNote: tidalNote)
    }
}

// MARK: - Hourly Data Point

struct HourlyDataPoint: Identifiable, Codable {
    let time: Date
    let waveHeightFt: Double
    let swellHeightFt: Double
    let windWaveHeightFt: Double
    let wavePeriod: Double
    var id: TimeInterval { time.timeIntervalSince1970 }
}

// MARK: - Surf Quality

struct SurfQuality: Codable {
    let label: String
    let score: Double

    static func evaluate(swell: SwellData?, wind: WindData?, beachFacing: Double) -> SurfQuality {
        guard let swell = swell, swell.swellHeight > 0.3 else {
            return SurfQuality(label: "FLAT", score: 0)
        }
        let ht = swell.swellHeight
        let htS: Double
        switch ht {
        case ..<0.5: htS = 0
        case 0.5..<1: htS = 2
        case 1..<2:   htS = 5
        case 2..<4:   htS = 8
        case 4..<8:   htS = 10
        case 8..<12:  htS = 6
        default:      htS = 2
        }
        let per = swell.swellPeriod
        let perS: Double
        switch per {
        case ..<7:    perS = 0
        case 7..<10:  perS = 4
        case 10..<13: perS = 7
        case 13..<16: perS = 9
        default:      perS = 10
        }
        var diff = abs(swell.swellDirection - beachFacing)
        if diff > 180 { diff = 360 - diff }
        let dirS: Double
        switch diff {
        case ..<20:   dirS = 10
        case 20..<45: dirS = 8
        case 45..<70: dirS = 5
        case 70..<90: dirS = 2
        default:      dirS = 0
        }
        let ws = wind?.speed ?? 0
        let windS: Double
        switch ws {
        case ..<5:    windS = 10
        case 5..<10:  windS = 8
        case 10..<15: windS = 5
        case 15..<20: windS = 2
        default:      windS = 0
        }
        let total = htS * 0.30 + perS * 0.30 + dirS * 0.25 + windS * 0.15
        let label: String
        switch total {
        case ..<2:  label = "FLAT"
        case 2..<4: label = "POOR"
        case 4..<6: label = "FAIR"
        case 6..<8: label = "GOOD"
        default:    label = "EPIC"
        }
        return SurfQuality(label: label, score: total)
    }
}

// MARK: - Surf Cache

struct SurfCache: Codable {
    let locationId: String
    let timestamp: Date
    let swellData: SwellData?
    let windData: WindData?
    let buoyData: BuoyObservation?
    let tideData: TideData?
    let uvIndex: Double?
    let sunData: SunData?
    let hourlyForecast: [HourlyDataPoint]
    let marineForecast: [NWSForecastPeriod]
    let ripCurrentRisk: String
    let ripCurrentDetail: String?
}

// MARK: - Tide Curve Interpolation

struct TidePoint: Identifiable {
    let id: Double
    let time: Date
    let height: Double
}

func interpolateTideCurve(from predictions: [NOAATidePrediction], steps: Int = 120) -> [TidePoint] {
    let sorted = predictions.compactMap { p -> (Date, Double)? in
        guard let d = p.date else { return nil }
        return (d, p.heightFeet)
    }.sorted { $0.0 < $1.0 }
    guard sorted.count >= 2 else { return [] }
    var points: [TidePoint] = []
    for i in 0..<(sorted.count - 1) {
        let (t1, h1) = sorted[i]
        let (t2, h2) = sorted[i + 1]
        let interval = t2.timeIntervalSince(t1)
        let segSteps = max(2, steps / (sorted.count - 1))
        for step in 0..<segSteps {
            let frac = Double(step) / Double(segSteps)
            let t = t1.addingTimeInterval(interval * frac)
            let h = h1 + (h2 - h1) * (1.0 - cos(frac * .pi)) / 2.0
            points.append(TidePoint(id: t.timeIntervalSince1970 + Double(i * 1000 + step), time: t, height: h))
        }
    }
    if let last = sorted.last {
        points.append(TidePoint(id: last.0.timeIntervalSince1970 + 9999, time: last.0, height: last.1))
    }
    return points
}

// MARK: - Helpers

func compassDirection(_ degrees: Double) -> String {
    let dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                "S","SSW","SW","WSW","W","WNW","NW","NNW"]
    let index = Int((degrees + 11.25) / 22.5) % 16
    return dirs[max(0, min(15, index))]
}

func windDescription(_ mph: Double) -> String {
    switch mph {
    case 0..<1:  return "Calm"
    case 1..<5:  return "Light Air"
    case 5..<11: return "Light Breeze"
    case 11..<19: return "Gentle Breeze"
    case 19..<28: return "Moderate Breeze"
    case 28..<38: return "Fresh Breeze"
    case 38..<49: return "Strong Breeze"
    default:     return "High Wind"
    }
}

// NEW: Wetsuit recommendation helper
func wetsuitRecommendation(waterTempF: Double) -> (suit: String, thickness: String) {
    switch waterTempF {
    case 72...:    return ("Boardshorts / Bikini", "No wetsuit")
    case 68..<72:  return ("Spring Suit", "2mm")
    case 63..<68:  return ("Full Suit", "3/2mm")
    case 58..<63:  return ("Full Suit", "4/3mm")
    case 52..<58:  return ("Full Suit + Boots", "5/4mm")
    default:       return ("Full Suit + Hood + Boots", "6/5mm")
    }
}

// NEW: Format a Date to local Pacific time string h:mm a
func formatLocalTime(_ date: Date) -> String {
    let f = DateFormatter()
    f.dateFormat = "h:mm a"
    f.timeZone = TimeZone(identifier: "America/Los_Angeles")
    return f.string(from: date)
}

// NEW: Relative time since observation
func relativeTime(since date: Date?) -> String {
    guard let d = date else { return "Unknown" }
    let mins = Int(Date().timeIntervalSince(d) / 60)
    if mins < 60 { return "\(mins)m ago" }
    return "\(mins / 60)h ago"
}
