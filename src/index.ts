import {EventEmitter} from 'events'
import logUpdate = require('log-update')
import R = require('ramda')
import * as supi from 'supi'
import xs, {Stream} from 'xstream'
import fromEvent from 'xstream/extra/fromEvent'
import PushStream = require('zen-push')
import mergeOutputs from './mergeOutputs'
import reporterForClient from './reporterForClient'
import reporterForServer from './reporterForServer'

export default function (
  streamParser: object,
  cmd?: string, // is optional only to be backward compatible
) {
  if (cmd === 'server') {
    const obs = fromEvent(streamParser as EventEmitter, 'data')
    const log$ = xs.fromObservable<supi.Log>(obs)
    reporterForServer(log$)
    return
  }
  toOutput$(streamParser, cmd)
    .subscribe({
      complete () {}, // tslint:disable-line:no-empty
      error: (err) => logUpdate(err.message),
      next: logUpdate,
    })
}

export function toOutput$ (
  streamParser: object,
  cmd?: string, // is optional only to be backward compatible
): Stream<string> {
  const isRecursive = cmd === 'recursive'
  const progressPushStream = new PushStream()
  const stagePushStream = new PushStream()
  const deprecationPushStream = new PushStream()
  const summaryPushStream = new PushStream()
  const lifecyclePushStream = new PushStream()
  const statsPushStream = new PushStream()
  const installCheckPushStream = new PushStream()
  const registryPushStream = new PushStream()
  const rootPushStream = new PushStream()
  const packageJsonPushStream = new PushStream()
  const linkPushStream = new PushStream()
  const otherPushStream = new PushStream()
  streamParser['on']('data', (log: supi.Log) => {
    switch (log.name) {
      case 'pnpm:progress':
        progressPushStream.next(log as supi.ProgressLog)
        break
      case 'pnpm:stage':
        stagePushStream.next(log as supi.StageLog)
        break
      case 'pnpm:deprecation':
        deprecationPushStream.next(log as supi.DeprecationLog)
        break
      case 'pnpm:summary':
        summaryPushStream.next(log)
        break
      case 'pnpm:lifecycle':
        lifecyclePushStream.next(log as supi.LifecycleLog)
        break
      case 'pnpm:stats':
        statsPushStream.next(log as supi.StatsLog)
        break
      case 'pnpm:install-check':
        installCheckPushStream.next(log as supi.InstallCheckLog)
        break
      case 'pnpm:registry':
        registryPushStream.next(log as supi.RegistryLog)
        break
      case 'pnpm:root':
        rootPushStream.next(log as supi.RootLog)
      case 'pnpm:package-json':
        packageJsonPushStream.next(log as supi.PackageJsonLog)
      case 'pnpm:link' as any: // tslint:disable-line
        linkPushStream.next(log)
        break
      case 'pnpm' as any: // tslint:disable-line
        otherPushStream.next(log)
        break
    }
  })
  const obs = fromEvent(streamParser as EventEmitter, 'data')
  const log$ = {
    deprecation: xs.fromObservable<supi.DeprecationLog>(deprecationPushStream.observable),
    installCheck: xs.fromObservable<supi.InstallCheckLog>(installCheckPushStream.observable),
    lifecycle: xs.fromObservable<supi.LifecycleLog>(lifecyclePushStream.observable),
    link: xs.fromObservable<supi.Log>(linkPushStream.observable),
    other: xs.fromObservable<supi.Log>(otherPushStream.observable),
    packageJson: xs.fromObservable<supi.PackageJsonLog>(packageJsonPushStream.observable),
    progress: xs.fromObservable<supi.ProgressLog>(progressPushStream.observable),
    registry: xs.fromObservable<supi.RegistryLog>(registryPushStream.observable),
    root: xs.fromObservable<supi.RootLog>(rootPushStream.observable),
    stage: xs.fromObservable<supi.StageLog>(stagePushStream.observable),
    stats: xs.fromObservable<supi.StatsLog>(statsPushStream.observable),
    summary: xs.fromObservable<supi.Log>(summaryPushStream.observable),
  }
  const outputs: Array<xs<xs<{msg: string}>>> = reporterForClient(log$, isRecursive, cmd)

  return mergeOutputs(outputs)
}
