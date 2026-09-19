import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import {
  runCrudMutationGuardAfterSuccess,
  validateCrudMutationGuard,
} from '@open-mercato/shared/lib/crud/mutation-guard'
import { createLogger } from '@open-mercato/shared/lib/logger'

/**
 * Trasa HTTP dla akcji dziedzinowej wołanej przez **człowieka**.
 *
 * Nie mylić z `edge/api/agentRoute.ts`: tamten obsługuje maszyny i uwierzytelnia
 * podpisem, ten obsługuje ludzi i uwierzytelnia sesją. Różnią się wszystkim —
 * kto woła, czym się legitymuje i co znaczy odmowa.
 *
 * Kształt zerżnięty świadomie z `executeWmsCustomPostRoute` rdzenia, bo to jest
 * konwencja domu dla komend dziedzinowych wystawionych po HTTP: zakres
 * organizacji rozstrzygany po stronie serwera, strażnik mutacji przed
 * wykonaniem, komenda przez szynę (czyli z wpisem do dziennika audytu),
 * i mapowanie wyjątków na kody stanu.
 *
 * Dlaczego nie importujemy helpera rdzenia wprost: leży w module `wms`,
 * a wtyczka robotyczna nie ma powodu zależeć od modułu magazynowego. Kopia
 * kosztuje sześćdziesiąt linii i zdejmuje zależność, której nikt by nie
 * potrafił uzasadnić przy przeglądzie.
 *
 * Dlaczego mieszka w `fleet`: ten moduł jest podstawą wtyczki. `deployment`
 * już importuje z niego reguły cyklu życia, `work_orders` i `vision` wiążą się
 * z jego celami. Odwrotnej zależności nie ma i mieć nie będzie.
 */

const logger = createLogger('fleet').child({ component: 'commandRoute' })

export type CommandRouteOptions<TInput, TResult> = {
  request: Request
  /** Ścieżka do logów i do opisu zasobu — nie do routingu. */
  routePath: string
  inputSchema: z.ZodType<TInput>
  commandId: string
  /**
   * Zakres i tenant dokładane do wejścia **po stronie serwera**.
   *
   * Komendy wtyczki wymagają `organizationId` i `tenantId` w wejściu. Gdyby
   * przychodziły w treści żądania, byłyby parametrem, którym da się sięgnąć
   * poza własnego tenanta — ta sama pułapka, którą opisuje `agentRoute.ts`.
   */
  withScope?: boolean
  describeResource: (input: TInput) => { resourceKind: string; resourceId: string }
  mapSuccess: (result: TResult) => Record<string, unknown>
}

export async function executeCommandRoute<TInput, TResult>(
  options: CommandRouteOptions<TInput, TResult>,
): Promise<Response> {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(options.request)
    if (!auth || !auth.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const organizationScope = await resolveOrganizationScopeForRequest({
      container,
      auth,
      request: options.request,
    })
    const organizationId = organizationScope?.selectedId ?? auth.orgId ?? null
    if (options.withScope !== false && !organizationId) {
      /*
       * Brak wybranej organizacji nie jest błędem technicznym: to znaczy, że
       * użytkownik patrzy na wszystkie naraz. Zapis maszyny musi wiedzieć,
       * której hali dotyczy, więc odmawiamy i mówimy to wprost.
       */
      return NextResponse.json(
        { error: 'Wybierz organizację — zapis musi wiedzieć, której hali dotyczy.' },
        { status: 400 },
      )
    }

    const ctx: CommandRuntimeContext = {
      container,
      auth,
      organizationScope,
      selectedOrganizationId: organizationId,
      organizationIds: organizationScope?.filterIds ?? (auth.orgId ? [auth.orgId] : null),
      request: options.request,
    } as unknown as CommandRuntimeContext

    const body = await readJsonSafe<Record<string, unknown>>(options.request, {})
    const wejscie = options.withScope === false
      ? body
      : { ...body, organizationId, tenantId: auth.tenantId }
    const parsed = options.inputSchema.parse(wejscie)

    const resource = options.describeResource(parsed)
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId,
      userId: auth.sub,
      resourceKind: resource.resourceKind,
      resourceId: resource.resourceId,
      operation: 'custom',
      requestMethod: options.request.method,
      requestHeaders: options.request.headers,
      mutationPayload: parsed as Record<string, unknown>,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const bus = container.resolve('commandBus') as CommandBus
    const envelope = await bus.execute<TInput, TResult>(options.commandId, { input: parsed, ctx })

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId,
        userId: auth.sub,
        resourceKind: resource.resourceKind,
        resourceId: resource.resourceId,
        operation: 'custom',
        requestMethod: options.request.method,
        requestHeaders: options.request.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json({ ok: true, ...options.mapSuccess(envelope.result) }, { status: 200 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Nieprawidłowe dane formularza', details: error.issues }, { status: 400 })
    }
    /**
     * 422, nie 500: komendy tej wtyczki odmawiają wyjątkiem z komunikatem
     * napisanym dla człowieka („Nie można dopuścić robota: brak ważnej
     * kalibracji camera_extrinsics"). To jest odpowiedź merytoryczna, a nie
     * awaria — i ma dotrzeć do formularza w całości, bo operator ma z niej
     * wiedzieć, co zrobić dalej.
     *
     * Cena tej decyzji: prawdziwa awaria bazy też wróci jako 422 z komunikatem
     * technicznym. Uznaję to za lepszy wybór niż połknięcie powodu odmowy,
     * ale zapisujemy pełny błąd do logu, żeby dało się to rozróżnić po stronie
     * serwera.
     */
    logger.error('Komenda odmówiła albo padła', {
      routePath: options.routePath,
      commandId: options.commandId,
      err: error,
    })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 422 },
    )
  }
}
