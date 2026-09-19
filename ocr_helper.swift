import Foundation
import Vision

guard CommandLine.arguments.count > 1 else {
    print("")
    exit(0)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

let request = VNRecognizeTextRequest { (request, error) in
    guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox
        print("\(candidate.string)\t\(box.origin.x)\t\(box.origin.y)\t\(box.size.width)\t\(box.size.height)")
    }
}
request.recognitionLevel = .accurate

let handler = VNImageRequestHandler(url: imageURL, options: [:])
do {
    try handler.perform([request])
} catch {
    print("")
}
