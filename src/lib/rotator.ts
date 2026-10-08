// 10X RPC — Status rotator default presets (up to 20)
export interface RotatorPresetInput {
  emoji: string | null
  text: string
  durationMins: number
}

export const DEFAULT_ROTATOR_PRESETS: RotatorPresetInput[] = [
  { emoji: '🎮', text: 'Playing something', durationMins: 5 },
  { emoji: '💻', text: 'Coding the future', durationMins: 5 },
  { emoji: '🎵', text: 'Listening to music', durationMins: 5 },
  { emoji: '📚', text: 'Studying hard', durationMins: 5 },
  { emoji: '😴', text: 'AFK — back soon', durationMins: 5 },
  { emoji: '🚀', text: 'Building 10X RPC', durationMins: 5 },
  { emoji: '☕', text: 'Coffee break', durationMins: 5 },
  { emoji: '🏆', text: 'Grinding ranked', durationMins: 5 },
  { emoji: '🛏️', text: 'Sleeping', durationMins: 5 },
  { emoji: '🎬', text: 'Watching a movie', durationMins: 5 },
  { emoji: '🍔', text: 'Eating dinner', durationMins: 5 },
  { emoji: '🏃', text: 'Out for a run', durationMins: 5 },
  { emoji: '🛠️', text: 'Fixing bugs', durationMins: 5 },
  { emoji: '🌅', text: 'Waking up', durationMins: 5 },
  { emoji: '🌙', text: 'Late night vibes', durationMins: 5 },
  { emoji: '🎨', text: 'Creating art', durationMins: 5 },
  { emoji: '🧠', text: 'Deep in thought', durationMins: 5 },
  { emoji: '⚡', text: 'In the zone', durationMins: 5 },
  { emoji: '🎯', text: 'Focused on goals', durationMins: 5 },
  { emoji: '🪐', text: 'Exploring the cosmos', durationMins: 5 },
]

export const MAX_ROTATOR_PRESETS = 20
