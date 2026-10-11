//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// Search-string helpers for conditional create (`ifNoneExist`).
enum FHIRSearch {
    /// `identifier=<system>|<value>`, escaped so that no value can change the meaning of the query.
    ///
    /// Two layers: FHIR token escaping (`\`, `,`, `|`, `$` are special inside a token), then URL percent-encoding of
    /// everything but unreserved characters, so `&`, `=`, `#`, `+`, spaces and the `|` separator cannot be misread.
    /// HAPI decodes the percent-encoding and then splits the token on the first unescaped `|`.
    static func identifierQuery(system: String, value: String) -> String {
        let pair = "\(escapeToken(system))|\(escapeToken(value))"
        return "identifier=\(percentEncode(pair))"
    }
    
    static func escapeToken(_ value: String) -> String {
        var out = ""
        for character in value {
            if character == "\\" || character == "," || character == "|" || character == "$" {
                out.append("\\")
            }
            out.append(character)
        }
        return out
    }
    
    static func percentEncode(_ value: String) -> String {
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }
}
