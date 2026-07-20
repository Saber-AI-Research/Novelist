import AppKit
import CryptoKit
import Foundation

struct PasteboardSnapshot: Codable {
    let items: [[String: String]]
}

struct PixelStats: Codable {
    let sampled: Int
    let nonWhite: Int
    let nonTransparent: Int
    let red: Int
}

struct ImageMetrics: Codable {
    let width: Int
    let height: Int
    let stats: PixelStats
}

enum PasteboardError: Error, CustomStringConvertible {
    case usage
    case unreadableType(String)
    case invalidImage(String)
    case invalidCrop(String)
    case writeFailed

    var description: String {
        switch self {
        case .usage:
            return "usage: pasteboard-helper snapshot|restore|write-png|fingerprint|image-metrics [path] [x y width height]"
        case .unreadableType(let type):
            return "pasteboard type could not be materialized: \(type)"
        case .invalidImage(let path):
            return "invalid PNG image: \(path)"
        case .invalidCrop(let reason):
            return "invalid image-metrics crop: \(reason)"
        case .writeFailed:
            return "NSPasteboard.writeObjects returned false"
        }
    }
}

let pasteboard = NSPasteboard.general
let encoder: JSONEncoder = {
    let value = JSONEncoder()
    value.outputFormatting = [.sortedKeys]
    return value
}()

func currentSnapshot() throws -> PasteboardSnapshot {
    let items = try (pasteboard.pasteboardItems ?? []).map { item in
        var values: [String: String] = [:]
        for type in item.types.sorted(by: { $0.rawValue < $1.rawValue }) {
            guard let data = item.data(forType: type) else {
                throw PasteboardError.unreadableType(type.rawValue)
            }
            values[type.rawValue] = data.base64EncodedString()
        }
        return values
    }
    return PasteboardSnapshot(items: items)
}

func fingerprint(_ snapshot: PasteboardSnapshot) throws -> String {
    let data = try encoder.encode(snapshot)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func restore(_ snapshot: PasteboardSnapshot) throws {
    pasteboard.clearContents()
    guard !snapshot.items.isEmpty else { return }
    let items = try snapshot.items.map { values -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for typeName in values.keys.sorted() {
            guard let encoded = values[typeName], let data = Data(base64Encoded: encoded) else {
                throw PasteboardError.unreadableType(typeName)
            }
            item.setData(data, forType: NSPasteboard.PasteboardType(typeName))
        }
        return item
    }
    if !pasteboard.writeObjects(items) {
        throw PasteboardError.writeFailed
    }
}

func writePng(_ path: String) throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let image = NSImage(data: data) else {
        throw PasteboardError.invalidImage(path)
    }
    let item = NSPasteboardItem()
    item.setData(data, forType: .png)
    if let tiff = image.tiffRepresentation {
        item.setData(tiff, forType: .tiff)
    }
    pasteboard.clearContents()
    if !pasteboard.writeObjects([item]) {
        throw PasteboardError.writeFailed
    }
}

func imageMetrics(_ path: String, rect: NSRect?) throws -> ImageMetrics {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let bitmap = NSBitmapImageRep(data: data) else {
        throw PasteboardError.invalidImage(path)
    }
    let imageBounds = NSRect(x: 0, y: 0, width: bitmap.pixelsWide, height: bitmap.pixelsHigh)
    let requestedBounds = rect ?? imageBounds
    guard requestedBounds.origin.x.isFinite,
          requestedBounds.origin.y.isFinite,
          requestedBounds.width.isFinite,
          requestedBounds.height.isFinite,
          requestedBounds.width > 0,
          requestedBounds.height > 0 else {
        throw PasteboardError.invalidCrop("crop rectangle must be finite with positive dimensions")
    }
    let sampleBounds = requestedBounds.integral
    guard sampleBounds.minX >= imageBounds.minX,
          sampleBounds.minY >= imageBounds.minY,
          sampleBounds.maxX <= imageBounds.maxX,
          sampleBounds.maxY <= imageBounds.maxY else {
        throw PasteboardError.invalidCrop("crop rectangle is outside image bounds")
    }

    let maxSamples = 250_000.0
    let step = max(1, Int(ceil(sqrt((sampleBounds.width * sampleBounds.height) / maxSamples))))
    var sampled = 0
    var nonWhite = 0
    var nonTransparent = 0
    var red = 0

    for topY in stride(from: Int(sampleBounds.minY), to: Int(sampleBounds.maxY), by: step) {
        for x in stride(from: Int(sampleBounds.minX), to: Int(sampleBounds.maxX), by: step) {
            guard let color = bitmap.colorAt(x: x, y: topY)?.usingColorSpace(.deviceRGB) else { continue }
            sampled += 1
            if color.alphaComponent > 0.05 { nonTransparent += 1 }
            if color.alphaComponent > 0.05 &&
                (color.redComponent < 0.97 || color.greenComponent < 0.97 || color.blueComponent < 0.97) {
                nonWhite += 1
            }
            if color.alphaComponent > 0.5 && color.redComponent > 0.7 &&
                color.greenComponent < 0.35 && color.blueComponent < 0.35 {
                red += 1
            }
        }
    }

    return ImageMetrics(
        width: bitmap.pixelsWide,
        height: bitmap.pixelsHigh,
        stats: PixelStats(sampled: sampled, nonWhite: nonWhite, nonTransparent: nonTransparent, red: red)
    )
}

do {
    guard CommandLine.arguments.count >= 2 else { throw PasteboardError.usage }
    let command = CommandLine.arguments[1]
    switch command {
    case "snapshot":
        guard CommandLine.arguments.count == 3 else { throw PasteboardError.usage }
        let snapshot = try currentSnapshot()
        try encoder.encode(snapshot).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
        print(try fingerprint(snapshot))
    case "restore":
        guard CommandLine.arguments.count == 3 else { throw PasteboardError.usage }
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        try restore(JSONDecoder().decode(PasteboardSnapshot.self, from: data))
        print(try fingerprint(currentSnapshot()))
    case "write-png":
        guard CommandLine.arguments.count == 3 else { throw PasteboardError.usage }
        try writePng(CommandLine.arguments[2])
        print(try fingerprint(currentSnapshot()))
    case "fingerprint":
        guard CommandLine.arguments.count == 2 else { throw PasteboardError.usage }
        print(try fingerprint(currentSnapshot()))
    case "image-metrics":
        guard CommandLine.arguments.count == 3 || CommandLine.arguments.count == 7 else {
            throw PasteboardError.usage
        }
        let rect: NSRect?
        if CommandLine.arguments.count == 7 {
            guard let x = Double(CommandLine.arguments[3]),
                  let y = Double(CommandLine.arguments[4]),
                  let width = Double(CommandLine.arguments[5]),
                  let height = Double(CommandLine.arguments[6]) else {
                throw PasteboardError.usage
            }
            rect = NSRect(x: x, y: y, width: width, height: height)
        } else {
            rect = nil
        }
        print(String(data: try encoder.encode(imageMetrics(CommandLine.arguments[2], rect: rect)), encoding: .utf8)!)
    default:
        throw PasteboardError.usage
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
