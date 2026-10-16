// Fixture projects must be explicitly pinned now that startup honors a default.
export async function reloadFixtureProject(page) {
  const pin = page.getByRole('button', { name: '设为默认工作流', exact: true })
  if (await pin.count()) await pin.click()
  await page.reload()
}
