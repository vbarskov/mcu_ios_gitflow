import AppKit
struct Row: Decodable { let text: String; let kind: String }
struct Page: Decodable { let title: String; let rows: [Row] }
let page = try JSONDecoder().decode(Page.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let width = 1440, height = 88 + page.rows.count * 25
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
func draw(_ text: String, _ y: Int, bold: Bool = false) {
 (text as NSString).draw(at: NSPoint(x: 20, y: y), withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: bold ? 17 : 18, weight: bold ? .semibold : .regular), .foregroundColor: NSColor(calibratedWhite: 0.15, alpha: 1)])
}
draw(page.title, height - 38, bold: true)
for (index, row) in page.rows.enumerated() {
 let y = height - 78 - index * 25
 let color: NSColor = row.kind == "+" ? NSColor(calibratedRed: 0.86, green: 0.96, blue: 0.88, alpha: 1) : row.kind == "-" ? NSColor(calibratedRed: 1, green: 0.89, blue: 0.89, alpha: 1) : NSColor(calibratedWhite: 0.96, alpha: 1)
 color.setFill(); NSRect(x: 12, y: y - 3, width: width - 24, height: 25).fill()
 draw(row.text, y)
}
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
