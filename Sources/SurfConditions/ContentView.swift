import SwiftUI
import Charts

// MARK: - Color palette

extension Color {
    static let oceanBg      = Color(red: 0.04, green: 0.09, blue: 0.18)
    static let oceanCard    = Color(red: 0.07, green: 0.15, blue: 0.27)
    static let oceanAccent  = Color(red: 0.18, green: 0.78, blue: 0.85)
    static let oceanGreen   = Color(red: 0.20, green: 0.85, blue: 0.60)
    static let oceanPurple  = Color(red: 0.60, green: 0.50, blue: 1.00)
    static let oceanText    = Color(red: 0.88, green: 0.93, blue: 1.00)
    static let oceanSubtext = Color(red: 0.50, green: 0.65, blue: 0.80)
    static let oceanBorder  = Color(red: 0.12, green: 0.28, blue: 0.45)
    static let oceanYellow  = Color(red: 0.95, green: 0.85, blue: 0.20)
    static let oceanRed     = Color(red: 0.90, green: 0.30, blue: 0.30)
}

// MARK: - Reusable components

struct CardContainer<Content: View>: View {
    let title: String
    let icon: String
    var accent: Color = .oceanAccent
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.callout)
                    .foregroundColor(accent)
                Text(title)
                    .font(.system(.caption, design: .monospaced))
                    .fontWeight(.bold)
                    .foregroundColor(accent)
                    .tracking(2)
            }
            Divider().background(Color.oceanBorder)
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.oceanCard)
        .cornerRadius(14)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.oceanBorder, lineWidth: 1))
    }
}

struct DataRow: View {
    let label: String
    let value: String
    var valueColor: Color = .oceanText

    var body: some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundColor(.oceanSubtext)
            Spacer()
            Text(value)
                .font(.system(.callout, design: .monospaced))
                .fontWeight(.medium)
                .foregroundColor(valueColor)
        }
    }
}

struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundColor(Color.oceanSubtext.opacity(0.7))
            .tracking(1.5)
            .padding(.top, 2)
    }
}

struct NoDataView: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle")
                .foregroundColor(.oceanSubtext)
                .font(.title2)
            Text("No data")
                .font(.callout)
                .foregroundColor(.oceanSubtext)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }
}

// MARK: - Swell Direction View

struct SwellDirectionView: View {
    let swellDirection: Double
    let beachFacing: Double

    var alignmentColor: Color {
        var diff = abs(swellDirection - beachFacing)
        if diff > 180 { diff = 360 - diff }
        if diff < 45 { return .oceanGreen }
        if diff < 70 { return .oceanYellow }
        return .oceanRed
    }

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .stroke(Color.oceanBorder, lineWidth: 1)
                    .frame(width: 72, height: 72)
                Text("N").font(.system(size: 9, weight: .semibold)).foregroundColor(.oceanSubtext).offset(y: -27)
                Text("S").font(.system(size: 9, weight: .semibold)).foregroundColor(.oceanSubtext).offset(y: 27)
                Text("E").font(.system(size: 9, weight: .semibold)).foregroundColor(.oceanSubtext).offset(x: 27)
                Text("W").font(.system(size: 9, weight: .semibold)).foregroundColor(.oceanSubtext).offset(x: -27)
                // Beach facing indicator (grey line)
                Capsule()
                    .fill(Color.oceanBorder)
                    .frame(width: 2, height: 24)
                    .offset(y: -12)
                    .rotationEffect(.degrees(beachFacing))
                // Swell arrow
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 20))
                    .foregroundColor(alignmentColor)
                    .rotationEffect(.degrees(swellDirection))
            }
            .frame(width: 72, height: 72)
            Text("SWELL ANGLE")
                .font(.system(size: 8, weight: .semibold, design: .monospaced))
                .foregroundColor(Color.oceanSubtext.opacity(0.6))
                .tracking(1)
        }
    }
}

// MARK: - Swell Card

struct SwellCard: View {
    let data: SwellData?
    let beachFacing: Double

    var body: some View {
        CardContainer(title: "SWELL", icon: "water.waves") {
            if let d = data {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "Combined Wave Height")

                    Text(String(format: "%.1f ft", d.waveHeight))
                        .font(.system(size: 38, weight: .bold, design: .monospaced))
                        .foregroundColor(.oceanAccent)

                    DataRow(label: "Period",    value: String(format: "%.0f sec", d.wavePeriod))
                    DataRow(label: "Direction", value: "\(compassDirection(d.waveDirection))  \(Int(d.waveDirection))°")

                    Divider().background(Color.oceanBorder).padding(.vertical, 4)

                    SectionLabel(text: "Primary Swell")

                    DataRow(label: "Height",    value: String(format: "%.1f ft", d.swellHeight))
                    DataRow(label: "Period",    value: String(format: "%.0f sec", d.swellPeriod))
                    DataRow(label: "Direction", value: "\(compassDirection(d.swellDirection))  \(Int(d.swellDirection))°")

                    Divider().background(Color.oceanBorder).padding(.vertical, 4)
                    HStack {
                        Spacer()
                        SwellDirectionView(
                            swellDirection: d.swellDirection,
                            beachFacing: beachFacing
                        )
                        Spacer()
                    }
                }
            } else {
                NoDataView()
            }
        }
    }
}

// MARK: - Wind Card

struct WindCard: View {
    let data: WindData?

    var speedColor: Color {
        guard let s = data?.speed else { return .oceanSubtext }
        if s < 10 { return .oceanGreen }
        if s < 20 { return .oceanAccent }
        if s < 30 { return .oceanYellow }
        return .oceanRed
    }

    var body: some View {
        CardContainer(title: "WIND", icon: "wind", accent: .oceanGreen) {
            if let d = data {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "Wind Speed")

                    HStack(alignment: .lastTextBaseline, spacing: 5) {
                        Text(String(format: "%.0f", d.speed))
                            .font(.system(size: 38, weight: .bold, design: .monospaced))
                            .foregroundColor(speedColor)
                        Text("mph")
                            .font(.callout)
                            .foregroundColor(.oceanSubtext)
                    }

                    Text(windDescription(d.speed))
                        .font(.caption)
                        .foregroundColor(.oceanSubtext)

                    Divider().background(Color.oceanBorder).padding(.vertical, 4)

                    SectionLabel(text: "Details")

                    DataRow(label: "Direction", value: "\(compassDirection(d.direction))  \(Int(d.direction))°")
                    DataRow(label: "Gusts",     value: String(format: "%.0f mph", d.gusts),
                            valueColor: d.gusts > 25 ? .oceanYellow : .oceanText)

                    Divider().background(Color.oceanBorder).padding(.vertical, 4)

                    HStack {
                        Spacer()
                        compassDial(direction: d.direction)
                        Spacer()
                    }
                }
            } else {
                NoDataView()
            }
        }
    }

    func compassDial(direction: Double) -> some View {
        ZStack {
            Circle()
                .stroke(Color.oceanBorder, lineWidth: 1)
                .frame(width: 80, height: 80)

            Text("N").font(.system(size: 10, weight: .semibold)).foregroundColor(.oceanSubtext).offset(y: -30)
            Text("E").font(.system(size: 10, weight: .semibold)).foregroundColor(.oceanSubtext).offset(x: 30)
            Text("S").font(.system(size: 10, weight: .semibold)).foregroundColor(.oceanSubtext).offset(y: 30)
            Text("W").font(.system(size: 10, weight: .semibold)).foregroundColor(.oceanSubtext).offset(x: -30)

            Image(systemName: "arrow.up")
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(.oceanGreen)
                .rotationEffect(.degrees(direction))
        }
        .frame(width: 80, height: 80)
    }
}

// MARK: - Tide Card

struct TideCard: View {
    let data: TideData?

    var body: some View {
        CardContainer(title: "TIDES", icon: "arrow.up.arrow.down", accent: .oceanPurple) {
            if let d = data {
                VStack(alignment: .leading, spacing: 8) {

                    // Rising / Falling status
                    if let rising = d.isRising {
                        HStack(spacing: 8) {
                            Image(systemName: rising ? "arrow.up.circle.fill" : "arrow.down.circle.fill")
                                .font(.title2)
                                .foregroundColor(rising ? .oceanGreen : .oceanAccent)
                            Text(rising ? "RISING" : "FALLING")
                                .font(.system(.title3, design: .monospaced))
                                .fontWeight(.bold)
                                .foregroundColor(rising ? .oceanGreen : .oceanAccent)
                        }
                        .padding(.bottom, 2)
                    }

                    // Next High
                    if let h = d.nextHigh {
                        SectionLabel(text: "Next High")
                        HStack {
                            Text(String(format: "%.1f ft", h.heightFeet))
                                .font(.system(.title3, design: .monospaced))
                                .fontWeight(.semibold)
                                .foregroundColor(.oceanText)
                            Spacer()
                            Text(h.formattedTime)
                                .font(.system(.callout, design: .monospaced))
                                .foregroundColor(.oceanSubtext)
                        }
                    }

                    // Next Low
                    if let l = d.nextLow {
                        SectionLabel(text: "Next Low")
                        HStack {
                            Text(String(format: "%.1f ft", l.heightFeet))
                                .font(.system(.title3, design: .monospaced))
                                .fontWeight(.semibold)
                                .foregroundColor(.oceanText)
                            Spacer()
                            Text(l.formattedTime)
                                .font(.system(.callout, design: .monospaced))
                                .foregroundColor(.oceanSubtext)
                        }
                    }

                    Divider().background(Color.oceanBorder).padding(.vertical, 4)

                    // Tide curve chart
                    let allPreds = (d.todayPredictions + d.futurePredictions)
                        .reduce(into: [NOAATidePrediction]()) { result, p in
                            if !result.contains(where: { $0.t == p.t }) { result.append(p) }
                        }
                        .sorted { ($0.date ?? .distantPast) < ($1.date ?? .distantPast) }

                    if allPreds.count >= 2 {
                        let curve = interpolateTideCurve(from: allPreds)
                        if !curve.isEmpty {
                            Chart {
                                ForEach(curve) { pt in
                                    AreaMark(x: .value("T", pt.time), y: .value("ft", pt.height))
                                        .foregroundStyle(Color.oceanPurple.opacity(0.15))
                                        .interpolationMethod(.catmullRom)
                                    LineMark(x: .value("T", pt.time), y: .value("ft", pt.height))
                                        .foregroundStyle(Color.oceanPurple.opacity(0.8))
                                        .lineStyle(StrokeStyle(lineWidth: 2))
                                        .interpolationMethod(.catmullRom)
                                }
                                RuleMark(x: .value("Now", Date()))
                                    .foregroundStyle(Color.oceanText.opacity(0.35))
                                    .lineStyle(StrokeStyle(dash: [3, 3]))
                            }
                            .chartXAxis(.hidden)
                            .chartYAxis {
                                AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { v in
                                    AxisGridLine().foregroundStyle(Color.oceanBorder.opacity(0.3))
                                    AxisValueLabel {
                                        if let dbl = v.as(Double.self) {
                                            Text(String(format: "%.0f", dbl))
                                                .font(.system(size: 9, design: .monospaced))
                                                .foregroundColor(.oceanSubtext)
                                        }
                                    }
                                }
                            }
                            .frame(height: 75)
                            .padding(.bottom, 6)
                        }
                    }

                    SectionLabel(text: "Today's Schedule")

                    if d.todayPredictions.isEmpty {
                        Text("No predictions available")
                            .font(.caption)
                            .foregroundColor(.oceanSubtext)
                    } else {
                        ForEach(d.todayPredictions) { p in
                            HStack(spacing: 10) {
                                Image(systemName: p.isHigh ? "arrow.up" : "arrow.down")
                                    .font(.caption2)
                                    .foregroundColor(p.isHigh ? .oceanGreen : .oceanAccent)
                                    .frame(width: 12)
                                Text(p.isHigh ? "High" : "Low ")
                                    .font(.caption)
                                    .foregroundColor(.oceanSubtext)
                                    .frame(width: 26, alignment: .leading)
                                Text(String(format: "%.1f ft", p.heightFeet))
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundColor(.oceanText)
                                Spacer()
                                Text(p.formattedTime)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundColor(.oceanSubtext)
                            }
                        }
                    }
                }
            } else {
                NoDataView()
            }
        }
    }
}

// MARK: - Sparkline View

struct SparklineView: View {
    let values: [Double]
    var color: Color = .oceanAccent

    var trendArrow: String {
        guard values.count >= 4 else { return "→" }
        let recent = values.suffix(3).reduce(0.0, +) / 3.0
        let older  = values.prefix(3).reduce(0.0, +) / 3.0
        if recent > older + 0.15 { return "↑" }
        if recent < older - 0.15 { return "↓" }
        return "→"
    }

    var arrowColor: Color {
        switch trendArrow {
        case "↑": return .oceanGreen
        case "↓": return .oceanAccent
        default:  return .oceanSubtext
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("TREND")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundColor(Color.oceanSubtext.opacity(0.6))
                    .tracking(1)
                Text(trendArrow)
                    .fontWeight(.bold)
                    .foregroundColor(arrowColor)
            }
            GeometryReader { geo in
                if values.count > 1,
                   let minV = values.min(), let maxV = values.max() {
                    let range = maxV - minV < 0.01 ? 1.0 : maxV - minV
                    let w = geo.size.width / CGFloat(values.count - 1)
                    Path { path in
                        for (i, v) in values.enumerated() {
                            let x = CGFloat(i) * w
                            let y = geo.size.height * CGFloat(1.0 - (v - minV) / range)
                            if i == 0 { path.move(to: CGPoint(x: x, y: y)) }
                            else       { path.addLine(to: CGPoint(x: x, y: y)) }
                        }
                    }
                    .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                }
            }
            .frame(height: 36)
        }
    }
}

// MARK: - Buoy Card

struct BuoyCard: View {
    let data: BuoyObservation?

    var body: some View {
        CardContainer(title: "BUOY 46240 · OBSERVED", icon: "antenna.radiowaves.left.and.right", accent: .oceanAccent) {
            if let d = data {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "Measured Wave Height")

                    Text(String(format: "%.1f ft", d.waveHeight))
                        .font(.system(size: 38, weight: .bold, design: .monospaced))
                        .foregroundColor(.oceanAccent)

                    DataRow(label: "Dom. Period",  value: String(format: "%.0f sec", d.dominantPeriod))
                    DataRow(label: "Avg Period",   value: String(format: "%.1f sec", d.avgPeriod))
                    DataRow(label: "Wave Dir.",    value: "\(compassDirection(d.waveDirection))  \(Int(d.waveDirection))°")

                    Divider().background(Color.oceanBorder).padding(.vertical, 4)

                    DataRow(label: "Buoy Wind",    value: String(format: "%.0f mph", d.windSpeed))
                    DataRow(label: "Wind Dir.",    value: "\(compassDirection(d.windDirection))  \(Int(d.windDirection))°")

                    Text("Observed \(relativeTime(since: d.observedAt))")
                        .font(.caption2)
                        .foregroundColor(.oceanSubtext)
                        .padding(.top, 4)

                    if !d.recentWaveHeights.isEmpty {
                        Divider().background(Color.oceanBorder).padding(.vertical, 4)
                        SparklineView(values: d.recentWaveHeights)
                    }
                }
            } else {
                NoDataView()
            }
        }
    }
}

// MARK: - Water Temp Card

struct WaterTempCard: View {
    let data: BuoyObservation?

    var body: some View {
        CardContainer(title: "WATER TEMP", icon: "thermometer.medium",
                      accent: Color(red: 0.2, green: 0.6, blue: 1.0)) {
            if let d = data {
                VStack(alignment: .leading, spacing: 8) {
                    Text(String(format: "%.1f °F", d.waterTemp))
                        .font(.system(size: 38, weight: .bold, design: .monospaced))
                        .foregroundColor(Color(red: 0.2, green: 0.6, blue: 1.0))

                    Divider().background(Color.oceanBorder).padding(.vertical, 4)

                    SectionLabel(text: "Recommended Gear")

                    let rec = wetsuitRecommendation(waterTempF: d.waterTemp)

                    Text(rec.suit)
                        .font(.system(.callout, design: .monospaced))
                        .fontWeight(.semibold)
                        .foregroundColor(.oceanText)

                    Text(rec.thickness)
                        .font(.caption)
                        .foregroundColor(.oceanSubtext)
                }
            } else {
                NoDataView()
            }
        }
    }
}

// MARK: - Sun Card

struct SunCard: View {
    let data: SunData?

    var body: some View {
        CardContainer(title: "SUN & GOLDEN HOUR", icon: "sun.horizon",
                      accent: Color(red: 1.0, green: 0.75, blue: 0.2)) {
            if let d = data {
                VStack(alignment: .leading, spacing: 6) {
                    DataRow(label: "First Light",
                            value: formatLocalTime(d.firstLight),
                            valueColor: .oceanSubtext)
                    DataRow(label: "Sunrise",
                            value: formatLocalTime(d.sunrise),
                            valueColor: Color(red: 1.0, green: 0.75, blue: 0.2))
                    DataRow(label: "AM Golden",
                            value: "until \(formatLocalTime(d.goldenHourMorningEnd))",
                            valueColor: Color(red: 1.0, green: 0.75, blue: 0.2))

                    Divider().background(Color.oceanBorder).padding(.vertical, 2)

                    DataRow(label: "PM Golden",
                            value: "from \(formatLocalTime(d.goldenHourEveningBegin))",
                            valueColor: Color(red: 1.0, green: 0.75, blue: 0.2))
                    DataRow(label: "Sunset",
                            value: formatLocalTime(d.sunset),
                            valueColor: Color(red: 1.0, green: 0.75, blue: 0.2))
                    DataRow(label: "Last Light",
                            value: formatLocalTime(d.lastLight),
                            valueColor: .oceanSubtext)
                }
            } else {
                NoDataView()
            }
        }
    }
}

// MARK: - Moon Card

struct MoonCard: View {
    let phase: MoonPhaseData

    var body: some View {
        CardContainer(title: "MOON PHASE", icon: "moon.stars",
                      accent: Color(red: 0.8, green: 0.8, blue: 1.0)) {
            VStack(alignment: .leading, spacing: 8) {
                Text(phase.emoji)
                    .font(.system(size: 40))

                Text(phase.name)
                    .font(.system(.title3, design: .monospaced))
                    .fontWeight(.semibold)
                    .foregroundColor(.oceanText)

                Text("\(Int(phase.illumination * 100))% illuminated")
                    .font(.callout)
                    .foregroundColor(.oceanSubtext)

                Divider().background(Color.oceanBorder).padding(.vertical, 2)

                Text(phase.tidalNote)
                    .font(.caption)
                    .foregroundColor(.oceanSubtext)
            }
        }
    }
}

// MARK: - Safety Card

struct SafetyCard: View {
    let uvIndex: Double?
    let ripRisk: String
    let ripDetail: String?

    var uvColor: Color {
        guard let uv = uvIndex else { return .oceanSubtext }
        switch uv {
        case ..<3:  return .oceanGreen
        case 3..<6: return .oceanYellow
        case 6..<8: return Color(red: 1.0, green: 0.55, blue: 0.2)
        case 8..<11: return .oceanRed
        default:    return .oceanPurple
        }
    }

    var uvCategory: String {
        guard let uv = uvIndex else { return "Unknown" }
        switch uv {
        case ..<3:  return "Low"
        case 3..<6: return "Moderate"
        case 6..<8: return "High"
        case 8..<11: return "Very High"
        default:    return "Extreme"
        }
    }

    var ripColor: Color {
        switch ripRisk {
        case "Low":      return .oceanGreen
        case "Moderate": return .oceanYellow
        case "High":     return .oceanRed
        default:         return .oceanSubtext
        }
    }

    var body: some View {
        CardContainer(title: "CONDITIONS & SAFETY", icon: "shield.fill",
                      accent: Color(red: 1.0, green: 0.55, blue: 0.2)) {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "UV Index")

                HStack(alignment: .lastTextBaseline, spacing: 6) {
                    Text(uvIndex.map { String(format: "%.0f", $0) } ?? "--")
                        .font(.system(size: 38, weight: .bold, design: .monospaced))
                        .foregroundColor(uvColor)
                    Text(uvCategory)
                        .font(.callout)
                        .foregroundColor(uvColor)
                }

                Divider().background(Color.oceanBorder).padding(.vertical, 4)

                SectionLabel(text: "Rip Current Risk")

                Text(ripRisk)
                    .font(.system(.title3, design: .monospaced))
                    .fontWeight(.bold)
                    .foregroundColor(ripColor)

                if let detail = ripDetail {
                    Text(detail)
                        .font(.caption)
                        .foregroundColor(.oceanSubtext)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

// MARK: - Marine Forecast Card

struct MarineForecastCard: View {
    let periods: [NWSForecastPeriod]

    var body: some View {
        CardContainer(title: "NWS MARINE FORECAST · PZZ535", icon: "text.quote",
                      accent: Color(red: 0.4, green: 0.8, blue: 0.9)) {
            if periods.isEmpty {
                NoDataView()
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(periods.prefix(2).enumerated()), id: \.offset) { idx, period in
                        if idx > 0 {
                            Divider().background(Color.oceanBorder)
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text(period.name)
                                .font(.caption)
                                .foregroundColor(.oceanSubtext)
                                .fontWeight(.semibold)
                            Text(period.detailedForecast)
                                .font(.caption)
                                .foregroundColor(.oceanText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Hourly Forecast Card

struct SwellSeriesPoint: Identifiable {
    let id = UUID()
    let time: Date
    let heightFt: Double
    let series: String
}

struct HourlyForecastCard: View {
    let points: [HourlyDataPoint]

    var seriesData: [SwellSeriesPoint] {
        points.flatMap { pt in [
            SwellSeriesPoint(time: pt.time, heightFt: pt.waveHeightFt,     series: "Combined Sea"),
            SwellSeriesPoint(time: pt.time, heightFt: pt.swellHeightFt,    series: "Primary Swell"),
            SwellSeriesPoint(time: pt.time, heightFt: pt.windWaveHeightFt, series: "Wind Waves"),
        ]}
    }

    static let seriesColors: KeyValuePairs<String, Color> = [
        "Combined Sea":  .oceanText,
        "Primary Swell": .oceanAccent,
        "Wind Waves":    .oceanYellow,
    ]

    var body: some View {
        CardContainer(title: "48-HOUR SWELL FORECAST", icon: "chart.line.uptrend.xyaxis", accent: .oceanAccent) {
            if points.isEmpty {
                NoDataView()
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    // Manual legend
                    HStack(spacing: 16) {
                        ForEach([
                            ("Combined Sea",  Color.oceanText),
                            ("Primary Swell", Color.oceanAccent),
                            ("Wind Waves",    Color.oceanYellow),
                        ], id: \.0) { label, color in
                            HStack(spacing: 5) {
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(color)
                                    .frame(width: 20, height: 3)
                                Text(label)
                                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                                    .foregroundColor(.oceanSubtext)
                            }
                        }
                    }

                    Chart(seriesData) { pt in
                        LineMark(
                            x: .value("Time",   pt.time),
                            y: .value("Height", pt.heightFt)
                        )
                        .foregroundStyle(by: .value("Series", pt.series))
                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                        .interpolationMethod(.catmullRom)

                        RuleMark(x: .value("Now", Date()))
                            .foregroundStyle(Color.oceanText.opacity(0.2))
                            .lineStyle(StrokeStyle(dash: [4, 4]))
                            .annotation(position: .top, alignment: .center) {
                                Text("NOW")
                                    .font(.system(size: 8, design: .monospaced))
                                    .foregroundColor(Color.oceanText.opacity(0.4))
                            }
                    }
                    .chartForegroundStyleScale([
                        "Combined Sea":  Color.oceanText.opacity(0.5),
                        "Primary Swell": Color.oceanAccent,
                        "Wind Waves":    Color.oceanYellow,
                    ])
                    .chartLegend(.hidden)
                    .chartXAxis {
                        AxisMarks(values: .automatic(desiredCount: 8)) { val in
                            AxisGridLine().foregroundStyle(Color.oceanBorder.opacity(0.3))
                            AxisValueLabel(format: .dateTime.hour(.defaultDigits(amPM: .abbreviated)), centered: true)
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(Color.oceanSubtext)
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { val in
                            AxisGridLine().foregroundStyle(Color.oceanBorder.opacity(0.3))
                            AxisValueLabel {
                                if let v = val.as(Double.self) {
                                    Text(String(format: "%.1f ft", v))
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundColor(.oceanSubtext)
                                }
                            }
                        }
                    }
                    .frame(height: 150)
                }
            }
        }
    }
}

// MARK: - Main View

struct ContentView: View {
    @EnvironmentObject var service: SurfDataService

    func surfQualityColor(_ label: String) -> Color {
        switch label {
        case "EPIC": return .purple
        case "GOOD": return .oceanGreen
        case "FAIR": return .oceanYellow
        case "POOR": return .oceanRed
        default:     return .oceanSubtext
        }
    }

    var body: some View {
        ZStack {
            Color.oceanBg.ignoresSafeArea()

            VStack(spacing: 0) {
                headerView

                if service.isLoading && service.swellData == nil && service.windData == nil {
                    loadingView
                } else {
                    ScrollView {
                        VStack(spacing: 14) {
                            if let err = service.errorMessage {
                                errorBanner(err)
                                    .padding(.horizontal, 20)
                            }

                            // Row 1: Swell, Wind, Tide
                            HStack(alignment: .top, spacing: 14) {
                                SwellCard(data: service.swellData, beachFacing: service.selectedLocation.beachFacing)
                                WindCard(data: service.windData)
                                TideCard(data: service.tideData)
                            }
                            .padding(.horizontal, 20)
                            .padding(.top, 14)

                            // Row 2: Buoy, Water Temp, Sun, Moon
                            HStack(alignment: .top, spacing: 14) {
                                BuoyCard(data: service.buoyData)
                                WaterTempCard(data: service.buoyData)
                                SunCard(data: service.sunData)
                                MoonCard(phase: service.moonPhase)
                            }
                            .padding(.horizontal, 20)

                            // Row 3: Safety, Marine Forecast
                            HStack(alignment: .top, spacing: 14) {
                                SafetyCard(
                                    uvIndex:   service.uvIndex,
                                    ripRisk:   service.ripCurrentRisk,
                                    ripDetail: service.ripCurrentDetail
                                )
                                MarineForecastCard(periods: service.marineForecast)
                            }
                            .padding(.horizontal, 20)
                            .padding(.bottom, 14)

                            // Row 4: 48-hour forecast
                            HourlyForecastCard(points: service.hourlyForecast)
                                .padding(.horizontal, 20)
                                .padding(.bottom, 14)
                        }
                    }
                }

                footerView
            }
        }
    }

    // MARK: Header

    var headerView: some View {
        VStack(spacing: 8) {
            // Location picker
            HStack {
                Picker("", selection: Binding(
                    get: { service.selectedLocation },
                    set: { service.selectLocation($0) }
                )) {
                    ForEach(SurfLocation.all) { loc in
                        Text(loc.name).tag(loc)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 380)
                Spacer()
            }

            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Image(systemName: "water.waves")
                            .foregroundColor(.oceanAccent)
                            .font(.title2)
                        Text(service.selectedLocation.name.uppercased())
                            .font(.system(.title2, design: .default))
                            .fontWeight(.bold)
                            .foregroundColor(.oceanText)
                            .tracking(2)
                    }
                    HStack(spacing: 5) {
                        Image(systemName: "mappin.circle")
                            .font(.caption)
                            .foregroundColor(.oceanSubtext)
                        Text("California Coast")
                            .font(.caption)
                            .foregroundColor(.oceanSubtext)
                        if let updated = service.lastUpdated {
                            Text("·")
                                .foregroundColor(Color.oceanSubtext.opacity(0.5))
                            Text("Updated \(updated, style: .time)")
                                .font(.caption)
                                .foregroundColor(.oceanSubtext)
                        }
                    }
                }

                Spacer()

                // Surf quality badge
                let q = service.surfQuality
                if q.label != "--" {
                    Text(q.label)
                        .font(.system(.callout, design: .monospaced))
                        .fontWeight(.bold)
                        .foregroundColor(surfQualityColor(q.label))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(surfQualityColor(q.label).opacity(0.15))
                        .cornerRadius(6)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(surfQualityColor(q.label).opacity(0.4), lineWidth: 1))
                }

                Button {
                    Task { await service.fetchAll() }
                } label: {
                    HStack(spacing: 6) {
                        if service.isLoading {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.oceanAccent)
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                        Text(service.isLoading ? "Updating…" : "Refresh")
                            .font(.callout)
                    }
                    .foregroundColor(.oceanAccent)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color.oceanCard)
                    .cornerRadius(8)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.oceanBorder, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(service.isLoading)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .background(
            LinearGradient(
                colors: [Color(red: 0.04, green: 0.11, blue: 0.24), Color.oceanBg],
                startPoint: .top, endPoint: .bottom
            )
        )
    }

    // MARK: Loading

    var loadingView: some View {
        VStack(spacing: 14) {
            Spacer()
            ProgressView()
                .scaleEffect(1.4)
                .tint(.oceanAccent)
            Text("Fetching surf conditions…")
                .font(.callout)
                .foregroundColor(.oceanSubtext)
            Spacer()
        }
    }

    // MARK: Error banner

    func errorBanner(_ msg: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
            Text(msg).font(.callout)
        }
        .foregroundColor(.oceanYellow)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.oceanYellow.opacity(0.08))
        .cornerRadius(8)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.oceanYellow.opacity(0.25), lineWidth: 1))
    }

    // MARK: Footer

    var footerView: some View {
        HStack(spacing: 5) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.caption2)
            Text("NOAA \(service.selectedLocation.tideStation) · NDBC \(service.selectedLocation.buoyStation) · Open-Meteo · NWS \(service.selectedLocation.marineZone) · sunrise-sunset.org")
                .font(.caption2)
        }
        .foregroundColor(Color.oceanSubtext.opacity(0.6))
        .padding(.horizontal, 20)
        .padding(.vertical, 11)
    }
}
