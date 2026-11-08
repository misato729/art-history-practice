import { assignBundledClassifications } from './question-classifications.ts'
import { pathToFileURL } from 'node:url'
import { closeDatabase } from '../core/db.ts'
import { closeRateLimitStore } from '../core/rate-limit.ts'
import { ApiError } from '../core/errors.ts'
import { migrate } from '../database/migrate.ts'
import { OperationError, importContent, importArchiveFile, exportArchive, seedContent } from './content.ts'
import { createAdmin, grantVerification, revokeVerification } from './accounts.ts'
import { auditOperations, expirePendingForUser } from './audit.ts'
import { restoreDrill } from './restore-drill.ts'
import { importStudyCategories } from './study-categories.ts'
import { applyContentStructure } from './structure.ts'

export const commands = ['questions:assign_categories', 'categories:import', 'db:migrate', 'db:baseline', 'db:seed', 'questions:import_content', 'questions:import', 'questions:export', 'questions:apply_structure',
  'admin:create', 'verification_access:grant', 'verification_access:revoke', 'payments:expire_pending_checkouts', 'operations:audit', 'operations:restore_drill'] as const

/** Inputs arrive through environment variables so passwords never enter command arguments. */
export async function runCommand(command: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  switch (command) {
    case 'questions:assign_categories': return assignBundledClassifications(env.CONFIRM)
    case 'categories:import': return importStudyCategories(env.INPUT, env.CONFIRM)
    case 'db:migrate': return { status: 'ok', ...await migrate() }
    case 'db:baseline': return { status: 'ok', ...await migrate({ baseline: true }) }
    case 'db:seed': return seedContent({ path: env.INPUT })
    case 'questions:import_content': return importContent(env.INPUT, env.CONFIRM)
    case 'questions:import':
      if (!env.INPUT) throw new OperationError('INPUTにアーカイブのパスを指定してください')
      return importArchiveFile(env.INPUT, env.CONFIRM)
    case 'questions:apply_structure': return applyContentStructure(env.INPUT, env.CONFIRM)
    case 'questions:export': return exportArchive(env.OUTPUT || '')
    case 'admin:create': return createAdmin({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, name: env.ADMIN_NAME })
    case 'verification_access:grant': return grantVerification({ email: env.USER_EMAIL, expiresAt: env.EXPIRES_AT, reason: env.REASON, grantedBy: env.GRANTED_BY })
    case 'verification_access:revoke': return revokeVerification(env.USER_EMAIL)
    case 'payments:expire_pending_checkouts': return expirePendingForUser(env.USER_EMAIL)
    case 'operations:audit': return auditOperations()
    case 'operations:restore_drill': return restoreDrill()
    default: throw new OperationError(`操作名を指定してください: ${commands.join(', ')}`)
  }
}

export function safeOperationFailure(error: unknown) {
  if (error instanceof OperationError) return { error: 'operation_failed', message: error.message }
  // API details can contain input; return only the stable code for validation/payment errors.
  if (error instanceof ApiError) return { error: error.code, message: '操作に必要な入力・状態・設定を確認してください' }
  return { error: 'operation_failed', message: '操作を完了できませんでした。DB接続・スキーマ・設定を確認してください' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await runCommand(process.argv[2])) + '\n') }
  catch (error) { process.stderr.write(JSON.stringify(safeOperationFailure(error)) + '\n'); process.exitCode = 1 }
  finally { await closeRateLimitStore(); await closeDatabase() }
}
