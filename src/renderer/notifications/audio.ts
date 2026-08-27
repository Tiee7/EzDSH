import {
  type NotificationEventId,
  type NotificationSettings,
  type NotificationSignal,
  type SoundId,
} from '../../shared/notifications.js'

interface Vibrato {
  rate: number
  depth: number
}

interface NoteOptions {
  freq: number
  dur: number
  at?: number
  glideTo?: number
  type?: OscillatorType
  gain?: number
  attack?: number
  vibrato?: Vibrato
}

let audioContext: AudioContext | undefined
let masterGain: GainNode | undefined
let currentVolume = 100

function volumeToGain(volume: number): number {
  return Math.pow(Math.max(0, Math.min(100, volume)) / 100, 1.5) * 0.9
}

/** Lazily unlock and create the local WebAudio graph after a user gesture. */
export function ensureAudio(): void {
  if (audioContext === undefined) {
    const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext }
    const Constructor = window.AudioContext ?? audioWindow.webkitAudioContext
    if (Constructor === undefined) return
    try {
      audioContext = new Constructor()
      masterGain = audioContext.createGain()
      masterGain.gain.value = volumeToGain(currentVolume)
      masterGain.connect(audioContext.destination)
    } catch {
      audioContext = undefined
      masterGain = undefined
      return
    }
  }
  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => undefined)
}

export function setVolume(volume: number): void {
  currentVolume = Math.max(0, Math.min(100, volume))
  if (masterGain !== undefined) masterGain.gain.value = volumeToGain(currentVolume)
}

function note(options: NoteOptions): void {
  const context = audioContext
  const master = masterGain
  if (context === undefined || master === undefined) return

  const start = context.currentTime + (options.at ?? 0)
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = options.type ?? 'sine'
  oscillator.frequency.setValueAtTime(options.freq, start)
  if (options.glideTo !== undefined) oscillator.frequency.exponentialRampToValueAtTime(options.glideTo, start + options.dur)

  const peak = options.gain ?? 0.3
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + (options.attack ?? 0.008))
  gain.gain.exponentialRampToValueAtTime(0.0001, start + options.dur)
  oscillator.connect(gain)
  gain.connect(master)

  if (options.vibrato !== undefined) {
    const lfo = context.createOscillator()
    const lfoGain = context.createGain()
    lfo.frequency.value = options.vibrato.rate
    lfoGain.gain.value = options.vibrato.depth
    lfo.connect(lfoGain)
    lfoGain.connect(oscillator.frequency)
    lfo.start(start)
    lfo.stop(start + options.dur + 0.05)
  }
  oscillator.start(start)
  oscillator.stop(start + options.dur + 0.05)
}

const players: Record<SoundId, () => void> = {
  'soft-ping': () => note({ freq: 880, dur: 0.4, gain: 0.3 }),
  'blip': () => note({ freq: 520, glideTo: 390, dur: 0.09, type: 'triangle', gain: 0.4 }),
  'tick': () => note({ freq: 1900, dur: 0.035, gain: 0.12 }),
  'pulse': () => {
    note({ freq: 660, dur: 0.08, gain: 0.3 })
    note({ freq: 660, at: 0.12, dur: 0.09, gain: 0.3 })
  },
  'bubble-pop': () => {
    note({ freq: 420, glideTo: 1050, dur: 0.07, gain: 0.5 })
    note({ freq: 1600, at: 0.06, dur: 0.03, gain: 0.18 })
  },
  'double-pop': () => {
    note({ freq: 420, glideTo: 1050, dur: 0.07, gain: 0.5 })
    note({ freq: 1600, at: 0.06, dur: 0.03, gain: 0.18 })
    note({ freq: 420, at: 0.11, glideTo: 1050, dur: 0.07, gain: 0.5 })
    note({ freq: 1600, at: 0.17, dur: 0.03, gain: 0.18 })
  },
  'plop': () => note({ freq: 430, glideTo: 160, dur: 0.12, gain: 0.5 }),
  'bloop': () => note({ freq: 290, glideTo: 540, dur: 0.16, type: 'triangle', gain: 0.45 }),
  'wobble': () => note({ freq: 440, dur: 0.3, gain: 0.32, vibrato: { rate: 14, depth: 38 } }),
  'chime': () => {
    note({ freq: 659.25, dur: 0.5, gain: 0.3 })
    note({ freq: 880, at: 0.12, dur: 0.6, gain: 0.32 })
  },
  'bell': () => {
    note({ freq: 784, dur: 0.8, gain: 0.28 })
    note({ freq: 1568, dur: 0.5, gain: 0.1 })
    note({ freq: 2352, dur: 0.3, gain: 0.05 })
  },
  'crystal': () => {
    note({ freq: 1568, dur: 0.35, gain: 0.24 })
    note({ freq: 3136, dur: 0.2, gain: 0.06 })
  },
  'music-box': () => {
    note({ freq: 1046.5, dur: 0.3, gain: 0.26 })
    note({ freq: 1318.5, at: 0.13, dur: 0.3, gain: 0.26 })
    note({ freq: 1568, at: 0.26, dur: 0.4, gain: 0.26 })
  },
  'wind-chime': () => {
    note({ freq: 1318.5, dur: 0.4, gain: 0.16 })
    note({ freq: 1760, at: 0.09, dur: 0.4, gain: 0.16 })
    note({ freq: 2093, at: 0.18, dur: 0.4, gain: 0.16 })
    note({ freq: 2637, at: 0.27, dur: 0.45, gain: 0.16 })
  },
  'rise': () => note({ freq: 300, glideTo: 1200, dur: 0.25, gain: 0.3 }),
  'complete': () => {
    note({ freq: 523.25, dur: 0.35, gain: 0.3 })
    note({ freq: 659.25, at: 0.09, dur: 0.35, gain: 0.3 })
    note({ freq: 784, at: 0.18, dur: 0.45, gain: 0.3 })
  },
  'climb': () => {
    note({ freq: 523.25, dur: 0.25, gain: 0.26 })
    note({ freq: 587.33, at: 0.07, dur: 0.25, gain: 0.26 })
    note({ freq: 659.25, at: 0.14, dur: 0.25, gain: 0.26 })
    note({ freq: 784, at: 0.21, dur: 0.3, gain: 0.26 })
  },
  'sparkle': () => {
    note({ freq: 1568, dur: 0.2, gain: 0.14 })
    note({ freq: 2093, at: 0.06, dur: 0.2, gain: 0.14 })
    note({ freq: 2637, at: 0.12, dur: 0.25, gain: 0.14 })
  },
  'alert': () => {
    note({ freq: 880, dur: 0.12, type: 'square', gain: 0.1 })
    note({ freq: 659.25, at: 0.16, dur: 0.18, type: 'square', gain: 0.1 })
  },
  'knock': () => {
    note({ freq: 150, glideTo: 90, dur: 0.08, gain: 0.6 })
    note({ freq: 150, at: 0.18, glideTo: 90, dur: 0.09, gain: 0.6 })
  },
}

export function playSound(id: SoundId): void {
  ensureAudio()
  players[id]?.()
}

function eventSetting(settings: NotificationSettings, event: NotificationEventId): { enabled: boolean; sound: SoundId } {
  switch (event) {
    case 'question': return { enabled: settings.questionOn, sound: settings.questionSound }
    case 'approval': return { enabled: settings.approvalOn, sound: settings.approvalSound }
    case 'task': return { enabled: settings.taskOn, sound: settings.taskSound }
    case 'job': return { enabled: settings.jobOn, sound: settings.jobSound }
    case 'subagent': return { enabled: settings.subagentOn, sound: settings.subagentSound }
    case 'error': return { enabled: settings.errorOn, sound: settings.errorSound }
  }
}

/** Resolve the selected sound for a preview without consulting its enabled switch. */
export function notificationPreviewSound(settings: NotificationSettings, event: NotificationEventId): SoundId {
  return eventSetting(settings, event).sound
}

/** Preview is an explicit user gesture, so it intentionally ignores notification switches. */
export function previewNotificationSound(settings: NotificationSettings, event: NotificationEventId): void {
  setVolume(settings.volume)
  playSound(notificationPreviewSound(settings, event))
}

/** Play a signal only when the global and event-specific sound switches allow it. */
export function playNotificationSound(notification: NotificationSignal, settings: NotificationSettings): void {
  if (!settings.master) return
  const selected = eventSetting(settings, notification.event)
  if (!selected.enabled) return
  setVolume(settings.volume)
  playSound(selected.sound)
}
