const secondsPerDay = 24 * 60 * 60
const daysPerYear = 365.2422
const secondsPerYear = daysPerYear * secondsPerDay
const secondsPerMonth = secondsPerYear / 12
const maxWaitSeconds = Number.MAX_SAFE_INTEGER - 300
const binary64Buffer = new ArrayBuffer(8)
const binary64View = new DataView(binary64Buffer)

function roundHalfEven(value, places = 4) {
  if (!Number.isFinite(value) || value === 0) return value

  // Match Python round(value, places) from the exact binary64 input. Multiplying
  // by 10 ** places first can erase whether a decimal half-way value lies just
  // above or below the tie, which changes gcloud's component normalization.
  const negative = value < 0
  binary64View.setFloat64(0, Math.abs(value), false)
  const bits = binary64View.getBigUint64(0, false)
  const exponentBits = Number((bits >> 52n) & 0x7ffn)
  const fractionBits = bits & ((1n << 52n) - 1n)
  let significand = fractionBits
  let binaryExponent = -1074
  if (exponentBits !== 0) {
    significand |= 1n << 52n
    binaryExponent = exponentBits - 1023 - 52
  }

  let numerator = significand * (10n ** BigInt(places))
  let denominator = 1n
  if (binaryExponent >= 0) {
    numerator <<= BigInt(binaryExponent)
  } else {
    denominator <<= BigInt(-binaryExponent)
  }

  let rounded = numerator / denominator
  const remainder = numerator % denominator
  const halfComparison = remainder * 2n - denominator
  if (halfComparison > 0n || (halfComparison === 0n && rounded % 2n === 1n)) {
    rounded += 1n
  }

  let decimal = rounded.toString()
  if (places > 0) {
    decimal = decimal.padStart(places + 1, '0')
    decimal = `${decimal.slice(0, -places)}.${decimal.slice(-places)}`
  }
  return Number(`${negative ? '-' : ''}${decimal}`)
}

function percolate(value) {
  const whole = Math.trunc(value)
  const fraction = roundHalfEven(roundHalfEven(value) - whole)
  return [whole, fraction]
}

function normalizeGcloudDuration(parts) {
  let [years, yearsFraction] = percolate(parts.years)
  let days = parts.days + daysPerYear * yearsFraction

  let [months, monthsFraction] = percolate(parts.months)
  days += Math.trunc(daysPerYear * monthsFraction / 12)

  let [wholeDays, daysFraction] = percolate(days)
  let hours = parts.hours + 24 * daysFraction
  let [wholeHours, hoursFraction] = percolate(hours)
  let minutes = parts.minutes + 60 * hoursFraction
  let [wholeMinutes, minutesFraction] = percolate(minutes)
  let seconds = parts.seconds + 60 * minutesFraction
  let [wholeSeconds, secondsFraction] = percolate(seconds)
  let microseconds = Math.trunc(1_000_000 * secondsFraction)

  let totalSeconds = 0
  let carry = Math.trunc(microseconds / 1_000_000)
  microseconds -= carry * 1_000_000
  totalSeconds += microseconds / 1_000_000
  wholeSeconds += carry

  carry = Math.trunc(wholeSeconds / 60)
  wholeSeconds -= carry * 60
  totalSeconds += wholeSeconds
  wholeMinutes += carry

  carry = Math.trunc(wholeMinutes / 60)
  wholeMinutes -= carry * 60
  totalSeconds += wholeMinutes * 60
  wholeHours += carry

  if (wholeDays || months || years) {
    carry = Math.trunc(wholeHours / 24)
    wholeHours -= carry * 24
    totalSeconds += wholeHours * 60 * 60
    wholeDays += carry

    if (wholeDays >= 366) {
      wholeDays -= 366
      years += 1
    } else if (wholeDays <= -366) {
      wholeDays += 366
      years -= 1
    }
    carry = Math.trunc(wholeDays / daysPerYear)
    wholeDays -= Math.trunc(carry * daysPerYear)
    totalSeconds += wholeDays * secondsPerDay
    years += carry

    carry = Math.trunc(months / 12)
    months -= carry * 12
    totalSeconds += months * secondsPerMonth
    years += carry
    totalSeconds += years * secondsPerYear
    totalSeconds = roundHalfEven(totalSeconds, 0) + microseconds / 1_000_000
  } else {
    totalSeconds += wholeHours * 60 * 60
  }

  return totalSeconds
}

function validatedSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > maxWaitSeconds) {
    throw new Error('duration is outside the supported wait range')
  }
  return Math.ceil(seconds)
}

function parseCloudDurationSeconds(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('duration is required')
  }

  // gcloud's Duration parser first tries Python int(), which accepts surrounding
  // whitespace and underscores, and treats that value as seconds.
  const bareInteger = value.trim()
  if (/^[+-]?[0-9]+(?:_[0-9]+)*$/.test(bareInteger)) {
    return validatedSeconds(Number(bareInteger.replaceAll('_', '')))
  }

  const original = value.toUpperCase()
  let duration = original
  let sign = 1
  if (duration.startsWith('-')) {
    sign = -1
    duration = duration.slice(1)
  } else if (duration.startsWith('+')) {
    duration = duration.slice(1)
  }
  if (sign < 0) throw new Error('negative durations are below Cloud Run\'s minimum')

  let timeSeparatorSeen = false
  let timePartImplied = false
  if (duration.startsWith('P')) {
    duration = duration.slice(1)
  } else {
    timePartImplied = true
  }

  const parts = { years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0 }
  let amount = ''
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

    const component = Number(amount)
    if (!Number.isFinite(component)) throw new Error('duration component is out of range')
    amount = ''

    if (['M', 'U', 'N'].includes(character)
      && index + 2 === duration.length
      && duration[index + 1] === 'S') {
      const divisor = character === 'M' ? 1_000 : character === 'U' ? 1_000_000 : 1_000_000_000
      parts.seconds += component / divisor
      index += 1
      continue
    }

    switch (character) {
      case 'Y':
        parts.years += component
        break
      case 'W':
        parts.days += component * 7
        break
      case 'D':
        parts.days += component
        break
      case 'H':
        parts.hours += component
        timePartImplied = true
        break
      case 'M':
        if (timePartImplied) {
          parts.minutes += component
        } else {
          parts.months += component
          timePartImplied = true
        }
        break
      case 'S':
        parts.seconds += component
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

  return validatedSeconds(normalizeGcloudDuration(parts))
}

try {
  if (process.argv.length !== 3) throw new Error('expected one duration argument')
  process.stdout.write(`${parseCloudDurationSeconds(process.argv[2])}\n`)
} catch {
  process.exitCode = 1
}
