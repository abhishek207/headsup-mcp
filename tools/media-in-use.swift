// Prints {"mic":bool}: whether any microphone is in use by any app (a call, a
// recording). It only reads CoreAudio device state; it never opens a device, so it
// doesn't trigger the macOS privacy indicator. Cameras are deliberately not checked:
// listing CoreMediaIO devices wakes a nearby iPhone's Continuity Camera, and every
// call that uses a camera also uses a microphone.
// Build: swiftc -O tools/media-in-use.swift -o bin/media-in-use

import CoreAudio
import Foundation

func audioDevices() -> [AudioObjectID] {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func hasInput(_ id: AudioObjectID) -> Bool {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr && size > 0
}

func audioRunning(_ id: AudioObjectID) -> Bool {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var running: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &running) == noErr && running != 0
}

let mic = audioDevices().contains { hasInput($0) && audioRunning($0) }
print("{\"mic\":\(mic)}")
