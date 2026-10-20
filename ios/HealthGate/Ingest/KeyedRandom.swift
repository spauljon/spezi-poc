//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

/// A random source with no state: `unit(stream, index)` is a pure function of (seed, stream, index).
///
/// That is the property the generator needs: the value for "heart-rate slot 123456" is the same whether the window
/// containing it was generated in one call or in a hundred, on any run, and a different seed gives different values.
/// SplitMix64's finalizer over a keyed counter; reference vectors (computed by an independent Python implementation)
/// are in the tests.
struct KeyedRandom: Sendable, Equatable {
    var seed: UInt64
    
    private static let golden: UInt64 = 0x9E37_79B9_7F4A_7C15
    private static let streamStride: UInt64 = 0xD1B5_4A32_D192_ED03
    
    func raw(_ stream: UInt64, _ index: Int64) -> UInt64 {
        var z = seed &+ stream &* Self.streamStride &+ UInt64(bitPattern: index) &* Self.golden
        z = z &+ Self.golden
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    
    /// Uniform in [0, 1).
    func unit(_ stream: UInt64, _ index: Int64) -> Double {
        Double(raw(stream, index) >> 11) * (1.0 / 9_007_199_254_740_992.0)
    }
}
