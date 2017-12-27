import chalk from 'chalk'
import os = require('os')
import prettyBytes = require('pretty-bytes')
import R = require('ramda')
import semver = require('semver')
import {
  DeprecationLog,
  InstallCheckLog,
  LifecycleLog,
  Log,
  ProgressLog,
  RegistryLog,
} from 'supi'
import * as supi from 'supi'
import xs, {Stream} from 'xstream'
import getPkgsDiff, {
  PackageDiff,
  propertyByDependencyType,
} from './pkgsDiff'
import reportError from './reportError'

const EOL = os.EOL
const BIG_TARBALL_SIZE = 1024 * 1024 * 5 // 5 MB

const addedSign = chalk.green('+')
const removedSign = chalk.red('-')
const linkSign = chalk.magentaBright('#')
const hlValue = chalk.blue
const hlPkgId = chalk['whiteBright']

export default function (
  log$: {
    progress: xs<supi.ProgressLog>,
    stage: xs<supi.StageLog>,
    deprecation: xs<supi.DeprecationLog>,
    summary: xs<supi.Log>,
    lifecycle: xs<supi.LifecycleLog>,
    stats: xs<supi.StatsLog>,
    installCheck: xs<supi.InstallCheckLog>,
    registry: xs<supi.RegistryLog>,
    root: xs<supi.RootLog>,
    packageJson: xs<supi.PackageJsonLog>,
    link: xs<supi.Log>,
    other: xs<supi.Log>,
  },
  isRecursive: boolean,
  cmd?: string, // is optional only to be backward compatible
): Array<xs<xs<{msg: string}>>> {
  const outputs: Array<xs<xs<{msg: string}>>> = []

  const resolutionDone$ = isRecursive
    ? xs.never()
    : log$.stage
      .filter((log) => log.message === 'resolution_done')
      .mapTo(true)
      .take(1)
      .startWith(false)

  const resolvingContentLog$ = log$.progress
    .filter((log) => log.status === 'resolving_content')
    .fold(R.inc, 0)
    .drop(1)
    .endWhen(resolutionDone$.last())

  const fedtchedLog$ = log$.progress
    .filter((log) => log.status === 'fetched')
    .fold(R.inc, 0)

  const foundInStoreLog$ = log$.progress
    .filter((log) => log.status === 'found_in_store')
    .fold(R.inc, 0)

  if (!isRecursive) {
    const alreadyUpToDate$ = xs.of(
      resolvingContentLog$
        .take(1)
        .mapTo(false)
        .startWith(true)
        .last()
        .filter(R.equals(true))
        .mapTo({
          fixed: false,
          msg: 'Already up-to-date',
        }),
    )

    outputs.push(alreadyUpToDate$)
  }

  const progressSummaryOutput$ = xs.of(
    xs.combine(
      resolvingContentLog$,
      fedtchedLog$,
      foundInStoreLog$,
      isRecursive ? xs.of(false) : resolutionDone$,
    )
    .map(
      R.apply((resolving, fetched, foundInStore: number, resolutionDone) => {
        const msg = `Resolving: total ${hlValue(resolving.toString())}, reused ${hlValue(foundInStore.toString())}, downloaded ${hlValue(fetched.toString())}`
        if (resolving === foundInStore + fetched && resolutionDone) {
          return {
            fixed: false,
            msg: `${msg}, done`,
          }
        }
        return {
          fixed: true,
          msg,
        }
      }),
    ),
  )

  outputs.push(progressSummaryOutput$)

  const tarballsProgressOutput$ = log$.progress
    .filter((log) => log.status === 'fetching_started' &&
      typeof log.size === 'number' && log.size >= BIG_TARBALL_SIZE)
    .map((startedLog) => {
      const size = prettyBytes(startedLog['size'])
      return log$.progress
        .filter((log) => log.status === 'fetching_progress' && log.pkgId === startedLog['pkgId'])
        .map((log) => log['downloaded'])
        .startWith(0)
        .map((downloadedRaw) => {
          const done = startedLog['size'] === downloadedRaw
          const downloaded = prettyBytes(downloadedRaw)
          return {
            fixed: !done,
            msg: `Downloading ${hlPkgId(startedLog['pkgId'])}: ${hlValue(downloaded)}/${hlValue(size)}${done ? ', done' : ''}`,
          }
        })
    })

  outputs.push(tarballsProgressOutput$)

  if (!isRecursive) {
    const pkgsDiff$ = getPkgsDiff(log$)

    const summaryLog$ = log$.summary
      .take(1)

    const summaryOutput$ = xs.combine(
      pkgsDiff$,
      summaryLog$,
    )
    .map(R.apply((pkgsDiff) => {
      let msg = ''
      for (const depType of ['prod', 'optional', 'dev']) {
        const diffs = R.values(pkgsDiff[depType])
        if (diffs.length) {
          msg += EOL
          msg += chalk.blue(`${propertyByDependencyType[depType]}:`)
          msg += EOL
          msg += printDiffs(diffs)
          msg += EOL
        }
      }
      return {msg}
    }))
    .take(1)
    .map(xs.of)

    outputs.push(summaryOutput$)

    const deprecationOutput$ = log$.deprecation
      // print warnings only about deprecated packages from the root
      .filter((log) => log.depth === 0)
      .map((log) => {
        return {
          msg: formatWarn(`${chalk.red('deprecated')} ${log.pkgName}@${log.pkgVersion}: ${log.deprecated}`),
        }
      })
      .map(xs.of)

    outputs.push(deprecationOutput$)
  }

  const lifecycleMessages: {[pkgId: string]: string} = {}
  const lifecycleOutput$ = xs.of(
    log$.lifecycle
      .filter((log) => log.name === 'pnpm:lifecycle')
      .map((log: LifecycleLog) => {
        const key = `${log.script}:${log.pkgId}`
        lifecycleMessages[key] = formatLifecycle(log)
        return R.values(lifecycleMessages).join(EOL)
      })
      .map((msg) => ({msg})),
  )

  outputs.push(lifecycleOutput$)

  if (!isRecursive) {
    outputs.push(
      log$.stats
        .take((cmd === 'install' || cmd === 'update') ? 2 : 1)
        .fold((acc, log) => {
          if (typeof log['added'] === 'number') {
            acc['added'] = log['added']
          } else if (typeof log['removed'] === 'number') {
            acc['removed'] = log['removed']
          }
          return acc
        }, {})
        .last()
        .map((stats) => {
          if (!stats['removed'] && !stats['added']) {
            return xs.empty()
          }

          const limit = 100
          let addSigns = (stats['added'] || 0)
          let removeSigns = (stats['removed'] || 0)
          const changes = addSigns + removeSigns
          if (changes > limit) {
            const p = limit / changes
            addSigns = Math.floor(addSigns * p)
            removeSigns = Math.floor(removeSigns * p)
          }
          let msg = EOL + 'Packages:'
          if (stats['removed']) {
            msg += ' ' + chalk.red(`-${stats['removed']}`)
          }
          if (stats['added']) {
            msg += ' ' + chalk.green(`+${stats['added']}`)
          }
          msg += EOL + R.repeat(removedSign, removeSigns).join('') + R.repeat(addedSign, addSigns).join('')
          return xs.of({msg})
        }),
    )

    const installCheckOutput$ = log$.installCheck
      .map(formatInstallCheck)
      .filter(Boolean)
      .map((msg) => ({msg}))
      .map(xs.of) as Stream<Stream<{msg: string}>>

    outputs.push(installCheckOutput$)

    const registryOutput$ = log$.registry
      .filter((log) => log.level === 'warn')
      .map((log: RegistryLog) => ({msg: formatWarn(log.message)}))
      .map(xs.of)

    outputs.push(registryOutput$)

    const miscOutput$ = (!isRecursive ? xs.merge(log$.link, log$.other) : log$.other)
      .map((obj) => {
        if (obj.level === 'debug') return
        if (obj.level === 'warn') {
          return formatWarn(obj['message'])
        }
        if (obj.level === 'error') {
          return reportError(obj)
        }
        return obj['message']
      })
      .map((msg) => ({msg}))
      .map(xs.of)

    outputs.push(miscOutput$)
  }

  return outputs
}

function printDiffs (pkgsDiff: PackageDiff[]) {
  // Sorts by alphabet then by removed/added
  // + ava 0.10.0
  // - chalk 1.0.0
  // + chalk 2.0.0
  pkgsDiff.sort((a, b) => (a.name.localeCompare(b.name) * 10 + (Number(!b.added) - Number(!a.added))))
  const msg = pkgsDiff.map((pkg) => {
    let result = pkg.added
      ? addedSign
      : pkg.linked
        ? linkSign
        : removedSign
    if (!pkg.realName || pkg.name === pkg.realName) {
      result += ` ${pkg.name}`
    } else {
      result += ` ${pkg.name} <- ${pkg.realName}`
    }
    if (pkg.version) {
      result += ` ${chalk.grey(pkg.version)}`
      if (pkg.latest && semver.lt(pkg.version, pkg.latest)) {
        result += ` ${chalk.grey(`(${pkg.latest} is available)`)}`
      }
    }
    if (pkg.deprecated) {
      result += ` ${chalk.red('deprecated')}`
    }
    if (pkg.linked) {
      result += ` ${chalk.magentaBright('linked from')} ${chalk.grey(pkg.from || '???')}`
    }
    return result
  }).join(EOL)
  return msg
}

function formatLifecycle (logObj: LifecycleLog) {
  const prefix = `Running ${hlValue(logObj.script)} for ${hlPkgId(logObj.pkgId)}`
  if (logObj['exitCode'] === 0) {
    return `${prefix}, done`
  }
  const line = formatLine(logObj)
  if (logObj.level === 'error') {
    return `${prefix}! ${line}`
  }
  return `${prefix}: ${line}`
}

function formatLine (logObj: LifecycleLog) {
  if (typeof logObj['exitCode'] === 'number') return chalk.red(`Exited with ${logObj['exitCode']}`)

  const color = logObj.level === 'error' ? chalk.red : chalk.gray
  return color(logObj['line'])
}

function formatInstallCheck (logObj: InstallCheckLog) {
  switch (logObj.code) {
    case 'EBADPLATFORM':
      return formatWarn(`Unsupported system. Skipping dependency ${logObj.pkgId}`)
    case 'ENOTSUP':
      return logObj.toString()
    default:
      return
  }
}

function formatWarn (message: string) {
  // The \u2009 is the "thin space" unicode character
  // It is used instead of ' ' because chalk (as of version 2.1.0)
  // trims whitespace at the beginning
  return `${chalk.bgYellow.black('\u2009WARN\u2009')} ${message}`
}
