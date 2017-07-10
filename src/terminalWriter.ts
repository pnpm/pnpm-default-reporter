import logUpdate = require('log-update')
import throttle = require('lodash.throttle')

const throttledUpdate = throttle(logUpdate, 200, { leading: true, trailing: false })

let fixed: string | null

export function write (line: string) {
  logUpdate(line)
  logUpdate.done()
  if (fixed) logUpdate(fixed)
}

export function fixedWrite (line: string) {
  fixed = line
  throttledUpdate(line)
}

export function done () {
  logUpdate(fixed)
  fixed = null
  logUpdate.done()
}
