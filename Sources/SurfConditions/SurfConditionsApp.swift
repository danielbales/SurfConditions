import SwiftUI

@main
struct SurfConditionsApp: App {
    @StateObject private var service = SurfDataService()

    var body: some Scene {
        WindowGroup("Surf Conditions") {
            ContentView()
                .environmentObject(service)
                .frame(minWidth: 960, minHeight: 620)
                .task {
                    service.loadCache()
                    await service.fetchAll()
                    service.startAutoRefresh()
                }
        }
        .defaultSize(width: 1100, height: 700)

        MenuBarExtra {
            MenuBarContentView()
                .environmentObject(service)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "water.waves").font(.system(size: 13))
                if let h = service.buoyData?.waveHeight {
                    Text(String(format: "%.1fft", h))
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                }
                let q = service.surfQuality.label
                if q != "--" && q != "FLAT" {
                    Text("·")
                    Text(q).font(.system(size: 11, weight: .bold, design: .monospaced))
                }
            }
        }
        .menuBarExtraStyle(.window)
    }
}

// MARK: - Menu Bar Content

struct MenuBarContentView: View {
    @EnvironmentObject var service: SurfDataService

    func qualityColor(_ label: String) -> Color {
        switch label {
        case "EPIC": return .purple
        case "GOOD": return .oceanGreen
        case "FAIR": return .oceanYellow
        case "POOR": return .oceanRed
        default:     return .oceanSubtext
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(service.selectedLocation.name.uppercased())
                        .font(.system(.caption, design: .monospaced))
                        .fontWeight(.bold)
                        .foregroundColor(.oceanSubtext)
                        .tracking(1.5)
                    Text(service.surfQuality.label)
                        .font(.system(.title2, design: .monospaced))
                        .fontWeight(.bold)
                        .foregroundColor(qualityColor(service.surfQuality.label))
                }
                Spacer()
                if service.isLoading { ProgressView().controlSize(.small).tint(.oceanAccent) }
            }

            Divider().background(Color.oceanBorder)

            if let s = service.swellData {
                mbRow("WAVE",  String(format: "%.1f ft", s.waveHeight))
                mbRow("SWELL", String(format: "%.1f ft  %.0f sec", s.swellHeight, s.swellPeriod))
            }
            if let b = service.buoyData {
                mbRow("BUOY", String(format: "%.1f ft  %.0f sec", b.waveHeight, b.dominantPeriod))
            }
            if let w = service.windData {
                mbRow("WIND", String(format: "%.0f mph %@", w.speed, compassDirection(w.direction)))
            }
            if let t = service.tideData {
                if let r = t.isRising { mbRow("TIDE", r ? "Rising" : "Falling") }
                if let h = t.nextHigh { mbRow("HI", String(format: "%.1f ft  %@", h.heightFeet, h.formattedTime)) }
                if let l = t.nextLow  { mbRow("LO", String(format: "%.1f ft  %@", l.heightFeet, l.formattedTime)) }
            }

            Divider().background(Color.oceanBorder)

            HStack {
                Button("Refresh") { Task { await service.fetchAll() } }
                    .buttonStyle(.plain).foregroundColor(.oceanAccent).font(.callout)
                Spacer()
                if let u = service.lastUpdated {
                    Text("Updated \(u, style: .time)")
                        .font(.caption2)
                        .foregroundColor(Color.oceanSubtext.opacity(0.6))
                }
            }
        }
        .padding(16)
        .frame(width: 300)
        .background(Color.oceanBg)
    }

    func mbRow(_ label: String, _ value: String) -> some View {
        HStack(spacing: 0) {
            Text(label)
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundColor(.oceanSubtext)
                .frame(width: 46, alignment: .leading)
                .tracking(1)
            Text(value)
                .font(.system(.callout, design: .monospaced))
                .foregroundColor(.oceanText)
        }
    }
}
