import Foundation

struct SurfLocation: Identifiable, Hashable, Codable {
    let id: String
    let name: String
    let lat: Double
    let lon: Double
    let beachFacing: Double
    let tideStation: String
    let tideStationName: String
    let marineZone: String
    let buoyStation: String
    let buoyName: String

    static func == (l: SurfLocation, r: SurfLocation) -> Bool { l.id == r.id }
    func hash(into h: inout Hasher) { h.combine(id) }

    static let all: [SurfLocation] = [
        SurfLocation(id: "carmel",   name: "Carmel Beach",
                     lat: 36.5535,  lon: -121.9255,
                     beachFacing: 280, tideStation: "9413375", tideStationName: "Carmel Cove",
                     marineZone: "PZZ535", buoyStation: "46236", buoyName: "Monterey Canyon"),
        SurfLocation(id: "asilomar", name: "Asilomar",
                     lat: 36.6213,  lon: -121.9427,
                     beachFacing: 285, tideStation: "9413450", tideStationName: "Monterey Harbor",
                     marineZone: "PZZ535", buoyStation: "46236", buoyName: "Monterey Canyon"),
        SurfLocation(id: "bigsur",   name: "Big Sur",
                     lat: 36.2344,  lon: -121.8173,
                     beachFacing: 270, tideStation: "9413375", tideStationName: "Carmel Cove",
                     marineZone: "PZZ565", buoyStation: "46239", buoyName: "Point Sur"),
    ]
}
