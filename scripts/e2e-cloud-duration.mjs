const secondsPerYear = 365.2422 * 24 * 60 * 60
const maxWaitSeconds = Number.MAX_SAFE_INTEGER - 300

function parseCloudDurationSeconds(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('duration is required')
  }

  const original = value.toUpperCase()
  if (/^[+-]?\d+$/.test(original)) {
    return validatedSeconds(Number(original))
  }

  let duration = original
  let sign = 1
  if (duration.startsWith('-')) {
    sign = -1
    duration = duration.slice(1)
  } else if (duration.startsWith('+')) {
    duration = duration.slice(1)
  }

  let timeSeparatorSeen = false
  let timePartImplied = false
  if (duration.startsWith('P')) {
    duration = duration.slice(1)
  } else {
    timePartImplied = true
  }

  let amount = ''
  let seconds = 0
  for (let index = 0; index < duration.length; index += 1) {
    const character = duration[index]
    if (/[0-9]/.test(character)) {
      amount += character
      continue
    }
    if (character === '.' || character === ',') {
      amount += '.'
      continue
    }
    if (character === 'T') {
      if (timeSeparatorSeen) throw new Error('duration has more than one T separator')
      timeSeparatorSeen = true
      timePartImplied = true
      continue
    }
    if (amount.length === 0) throw new Error('duration unit has no preceding number')

    const component = Number(amount) * sign
    if (!Number.isFinite(component)) throw new Error('duration component is out of range')
    amount = ''

    if (['M', 'U', 'N'].includes(character)
      && index + 2 === duration.length
      && duration[index + 1] === 'S') {
      const divisor = character === 'M' ? 1_000 : character === 'U' ? 1_000_000 : 1_000_000_000
      seconds += component / divisor
      index += 1
      continue
    }

    switch (character) {
      case 'Y':
        seconds += component * secondsPerYear
        break
      case 'W':
        seconds += component * 7 * 24 * 60 * 60
        break
      case 'D':
        seconds += component * 24 * 60 * 60
        break
      case 'H':
        seconds += component * 60 * 60
        timePartImplied = true
        break
      case 'M':
        if (timePartImplied) {
          seconds += component * 60
        } else {
          seconds += component * (secondsPerYear / 12)
          timePartImplied = true
        }
        break
      case 'S':
        seconds += component
        timePartImplied = true
        break
      default:
        throw new Error('duration contains an unknown unit')
    }
  }

  const unsignedOriginal = original.replace(/^[+-]/, '')
  if (amount.length > 0 && unsignedOriginal !== 'P0') {
    throw new Error('duration must end with a unit')
  }

  return validatedSeconds(Math.round(seconds * 10_000) / 10_000)
}

function validatedSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > maxWaitSeconds) {
    throw new Error('duration is outside the supported wait range')
  }
  return Math.ceil(seconds)
}

try {
  if (process.argv.length !== 3) throw new Error('expected one duration argument')
  process.stdout.write(`${parseCloudDurationSeconds(process.argv[2])}\n`)
} catch {
  process.exitCode = 1
}
