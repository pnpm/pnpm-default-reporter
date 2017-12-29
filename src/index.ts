import {EventEmitter} from 'events'
import logUpdate = require('log-update')
import most = require('most')
import R = require('ramda')
import * as supi from 'supi'
import PushStream = require('zen-push')
import mergeOutputs from './mergeOutputs'
import reporterForClient from './reporterForClient'
import reporterForServer from './reporterForServer'

export default function (
  streamParser: object,
  cmd?: string, // is optional only to be backward compatible
  width?: number,
) {
  if (cmd === 'server') {
    const log$ = most.fromEvent<supi.Log>('data', streamParser)
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
  width?: number,
): most.Stream<string> {
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
  setTimeout(() => { // setTimeout is a workaround for a strange bug in most https://github.com/cujojs/most/issues/491
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
          break
        case 'pnpm:package-json':
          packageJsonPushStream.next(log as supi.PackageJsonLog)
          break
        case 'pnpm:link' as any: // tslint:disable-line
          linkPushStream.next(log)
          break
        case 'pnpm' as any: // tslint:disable-line
          otherPushStream.next(log)
          break
      }
    })
  }, 0)
  const log$ = {
    deprecation: most.from<supi.DeprecationLog>(deprecationPushStream.observable),
    installCheck: most.from<supi.InstallCheckLog>(installCheckPushStream.observable),
    lifecycle: most.from<supi.LifecycleLog>(lifecyclePushStream.observable),
    link: most.from<supi.Log>(linkPushStream.observable),
    other: most.from<supi.Log>(otherPushStream.observable),
    packageJson: most.from<supi.PackageJsonLog>(packageJsonPushStream.observable),
    progress: most.from<supi.ProgressLog>(progressPushStream.observable),
    registry: most.from<supi.RegistryLog>(registryPushStream.observable),
    root: most.from<supi.RootLog>(rootPushStream.observable),
    stage: most.from<supi.StageLog>(stagePushStream.observable),
    stats: most.from<supi.StatsLog>(statsPushStream.observable),
    summary: most.from<supi.Log>(summaryPushStream.observable),
  }
  const outputs: Array<most.Stream<most.Stream<{msg: string}>>> = reporterForClient(log$, isRecursive, cmd, width)

  return mergeOutputs(outputs).multicast()
}
