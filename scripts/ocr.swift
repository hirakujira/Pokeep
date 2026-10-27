import Foundation
import ImageIO
import Vision

struct Line: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
}

struct Request: Decodable {
    let paths: [String]
}

struct Reply: Encodable {
    let lines: [[Line]]?
    let error: String?
}

func recognize(_ path: String) throws -> [Line] {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "PokeepOCR", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "無法讀取截圖"])
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hant", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { item in
        guard let candidate = item.topCandidates(1).first else { return nil }
        return Line(text: candidate.string,
                    confidence: candidate.confidence,
                    x: item.boundingBox.origin.x,
                    y: item.boundingBox.origin.y)
    }
}

let encoder = JSONEncoder()
while let input = readLine() {
    do {
        let request = try JSONDecoder().decode(Request.self, from: Data(input.utf8))
        let reply = Reply(lines: try request.paths.map(recognize), error: nil)
        let data = try encoder.encode(reply)
        print(String(decoding: data, as: UTF8.self))
    } catch {
        let reply = Reply(lines: nil, error: error.localizedDescription)
        let data = try! encoder.encode(reply)
        print(String(decoding: data, as: UTF8.self))
    }
    fflush(stdout)
}
