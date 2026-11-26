// Opens a page the way a person does: the section in the menu (opening the menu on a phone),
// then the page's tab when the section has several pages.
async function openPage(page, key) {
  const tab = page.locator('#sectionTabs [data-page="' + key + '"]');
  if (await tab.isVisible().catch(() => false)) {
    await tab.click();
    return;
  }
  const burger = page.locator('.topbar [data-action="open-side"]');
  if (await burger.isVisible().catch(() => false)) {
    const open = await page.locator("#sidebar").evaluate((el) => el.classList.contains("open")).catch(() => false);
    if (!open) await burger.click();
  }
  const section = page.locator('#nav [data-pages~="' + key + '"]');
  await section.waitFor({ state: "visible", timeout: 5000 });
  await section.click();
  if (await tab.count()) await tab.click();
  await page.waitForFunction((k) => window.SGOChatCore?.getPage?.() === k, key, { timeout: 5000 }).catch(() => {});
}

// Whether a page is offered to this person at all (in one of the menu's sections).
async function offered(page, key) {
  return (await page.locator('#nav [data-pages~="' + key + '"]').count()) > 0;
}

module.exports = { openPage, offered };
