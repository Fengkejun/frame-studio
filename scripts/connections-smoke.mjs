import { createServer } from 'node:http'
import { expect } from '@playwright/test'

export async function testConnections(page) {
  if (process.env.FRAME_STUDIO_CONNECTION_SMOKE !== '1') return
  let mode = 'success'
  const calls = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    calls.push({
      method: req.method,
      path: req.url,
      body: raw && JSON.parse(raw),
    })
    res.setHeader('Content-Type', 'application/json')
    if (mode === 'auth')
      return res.writeHead(401).end('{"error":{"message":"invalid key"}}')
    if (req.method === 'GET' && req.url === '/v1/models')
      return res.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] }))
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      expect(req.headers.authorization).toBe('Bearer fixture-connection-key')
      return res.end(
        JSON.stringify({
          choices: [{ message: { content: mode === 'empty' ? '' : 'OK' } }],
        }),
      )
    }
    res.writeHead(404).end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await page.getByRole('button', { name: '模型连接', exact: true }).click()
    await page.getByLabel('连接名称', { exact: true }).fill('连接诊断回归')
    await page.getByLabel('接入方式').selectOption('openai')
    await page
      .getByLabel('API 根地址')
      .fill(`http://127.0.0.1:${server.address().port}/v1`)
    await page.getByLabel('模型 ID', { exact: true }).fill('fixture-chat')
    await page
      .getByLabel('API Key', { exact: false })
      .fill('fixture-connection-key')
    // Regression: a complete new form must be testable without a separate save.
    await expect(
      page.getByRole('button', { name: '测试连接', exact: true }),
    ).toBeEnabled()
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByText(/连接正常，已找到配置的模型/)).toBeVisible()
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    await page
      .getByRole('button', { name: '测试模型回复', exact: true })
      .click()
    await expect(page.getByText(/模型回复验证通过/)).toBeVisible()
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toMatchObject({
      model: 'fixture-chat',
      stream: false,
      max_tokens: 32,
    })
    mode = 'empty'
    await page
      .getByRole('button', { name: '测试模型回复', exact: true })
      .click()
    await expect(
      page.locator('.connections-page [role="alert"]'),
    ).toContainText('有效文本')
    mode = 'auth'
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(
      page.locator('.connections-page [role="alert"]'),
    ).toContainText('HTTP 401')
    mode = 'success'
    await page.getByLabel('模型 ID', { exact: true }).fill('unlisted-chat')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByText(/列表未包含该模型/)).toBeVisible()
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2)
    console.log(
      'PASS: unsaved connection checks save current settings; catalog vs actual reply; empty reply and auth errors; model-not-listed warning. Local fixture only.',
    )
  } finally {
    await page.evaluate(async () => {
      const providers =
        await globalThis.__TAURI_INTERNALS__.invoke('list_providers')
      for (const provider of providers.filter((p) => p.name === '连接诊断回归'))
        await globalThis.__TAURI_INTERNALS__.invoke('remove_provider', {
          id: provider.id,
        })
    })
    await new Promise((resolve) => server.close(resolve))
  }
}
