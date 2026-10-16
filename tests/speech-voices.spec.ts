import { expect, test } from '@playwright/test'

test('speech generation uses the selected model catalog and ignores stale replies', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const submissions: unknown[] = []
    Object.assign(globalThis, {
      speechCatalogSubmissions: submissions,
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args: Record<string, unknown> = {}) => {
          if (cmd === 'get_app_info')
            return Promise.resolve({
              name: 'Frame Studio',
              version: '0.1.0',
              platform: 'fixture',
              architecture: 'fixture',
            })
          if (cmd === 'get_default_workflow' || cmd === 'get_composition')
            return Promise.resolve(null)
          if (cmd === 'speech_key_status') return Promise.resolve(true)
          if (cmd === 'list_speech_voices') {
            const model = String(args.model)
            const catalog = {
              id: `catalog-${model}`,
              baseUrl: args.baseUrl,
              model,
              source: 'official_live',
              sourceUrl: 'https://learn.microsoft.com',
              checkedAt: String(Date.now()),
              expiresAt: Date.now() + 900000,
              voices:
                model === 'mai-voice-2.1'
                  ? [
                      {
                        id: 'zh-CN-Harper',
                        name: 'Harper',
                        locale: 'zh-CN',
                        gender: 'Female',
                      },
                    ]
                  : [
                      {
                        id: 'coral',
                        name: 'coral',
                        locale: 'multilingual',
                        gender: '',
                      },
                    ],
            }
            if (model === 'gpt-4o-mini-tts')
              return new Promise((resolve) =>
                Object.assign(globalThis, {
                  releaseOldSpeechCatalog: () => resolve(catalog),
                }),
              )
            if (model === 'mai-voice-2.1') return Promise.resolve(catalog)
            return Promise.reject('当前模型的音色目录读取失败')
          }
          if (cmd === 'start_speech_job') {
            submissions.push(args.request)
            return Promise.resolve({
              id: 'fixture-job',
              request: args.request,
              status: 'failed',
              message: 'fixture',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              assetId: null,
              estimatedCostMicroUsd: 50000,
            })
          }
          if (cmd.startsWith('list_')) return Promise.resolve([])
          if (cmd === 'get_media_budget')
            return Promise.resolve({ limitMicroUsd: null, reservedMicroUsd: 0 })
          return Promise.resolve()
        },
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '时间线与导出', exact: true }).click()
  const generate = page.getByRole('button', { name: '生成配音', exact: true })
  await page.getByLabel('旁白文本').fill('别怕，我来了。')
  await expect(generate).toBeDisabled()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (
            globalThis as typeof globalThis & {
              releaseOldSpeechCatalog?: unknown
            }
          ).releaseOldSpeechCatalog,
      ),
    )
    .toBe('function')
  await page.locator('.speech-connection summary').click()
  await page.getByLabel('配音模型 ID').fill('mai-voice-2.1')
  await expect(
    page.getByLabel('配音音色').locator('option[value="zh-CN-Harper"]'),
  ).toHaveCount(1)
  await expect(generate).toBeDisabled()
  await page.getByLabel('配音音色').selectOption('zh-CN-Harper')
  await expect(generate).toBeEnabled()
  await page.evaluate(() =>
    (
      globalThis as typeof globalThis & { releaseOldSpeechCatalog: () => void }
    ).releaseOldSpeechCatalog(),
  )
  await expect(page.getByLabel('配音音色')).toHaveValue('zh-CN-Harper')
  await expect(
    page.getByLabel('配音音色').locator('option[value="coral"]'),
  ).toHaveCount(0)
  await generate.click()
  const requests = await page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          speechCatalogSubmissions: unknown[]
        }
      ).speechCatalogSubmissions,
  )
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    model: 'mai-voice-2.1',
    voice: 'zh-CN-Harper',
    voiceCatalogId: 'catalog-mai-voice-2.1',
    responseFormat: 'mp3',
  })
  await page.getByLabel('配音模型 ID').fill('other-model')
  await expect(
    page.getByText('当前模型的音色目录读取失败', { exact: true }),
  ).toBeVisible()
  await expect(generate).toBeDisabled()
  await expect(page.getByLabel('配音音色')).toHaveValue('')
})
