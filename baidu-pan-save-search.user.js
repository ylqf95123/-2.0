// ==UserScript==
// @name         百度网盘转存目录搜索
// @namespace    https://github.com/chajian/baidu-pan-save-search
// @version      0.5.0
// @description  在百度网盘分享页的保存到网盘弹窗中搜索自己的目录并跳转定位
// @match        https://pan.baidu.com/s/*
// @match        https://pan.baidu.com/share/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    cacheKey: "baidupan_folder_index_v1",
    recentKey: "baidupan_folder_recent_v1",
    indexTTL: 24 * 60 * 60 * 1000,
    maxDepth: 2,
    concurrency: 4,
    pageSize: 1000,
    debounceMs: 200,
    maxResults: 20,
    retryCount: 2,
    retryDelayMs: 500,
    refreshDelayMs: 120,
    nodeSearchAttempts: 8,
    pathVerifyAttempts: 12,
  };

  const SELECTORS = {
    dialog: [
      ".dialog-dialog",
      '[class*="dialog"]',
      '[class*="modal"]',
      '[class*="save-dialog"]',
      '[class*="transfer-dialog"]',
    ],
    header: [
      '[class*="dialog-header"]',
      '[class*="header"]',
      '[class*="title-wrap"]',
      '[class*="title"]',
    ],
    body: [
      '[class*="dialog-body"]',
      '[class*="content"]',
      '[class*="dialog-main"]',
      '[class*="bd"]',
    ],
    treeContainer: [
      '[role="tree"]',
      '[class*="tree"]',
      '[class*="scroll"]',
      '[class*="list"]',
      '[class*="content"]',
    ],
    treeNode: [
      '[role="treeitem"]',
      '[class*="tree-node"]',
      '[class*="tree-item"]',
      '[class*="node-item"]',
      '[class*="folder-item"]',
      '[data-type="folder"]',
      '[data-category="folder"]',
      'li[class*="item"]',
      'div[class*="item"]',
      "li",
    ],
    nodeLabel: [
      '[title]',
      '[data-name]',
      '[class*="name"]',
      '[class*="title"]',
      "span",
    ],
    expander: [
      '.plus-icon-operate',
      '.em-b-in-blk.plus-icon-operate',
      '[class*="plus-icon"]',
      '[class*="switch"]',
      '[class*="expand"]',
      '[class*="arrow"]',
      '[class*="caret"]',
      '[role="button"]',
    ],
    pathIndicator: [
      ".bottom-save-path",
      '[class*="save-path"]',
      '[class*="breadcrumb"]',
      '[class*="crumb"]',
      '[class*="path"]',
    ],
  };

  const state = {
    observer: null,
    styleReady: false,
    indexPromise: null,
    cachedFolders: null,
    searchTimer: 0,
    building: false,
    progressListeners: new Set(),
    lastProgress: null,
  };

  function emitProgress(progress) {
    state.lastProgress = progress;
    state.progressListeners.forEach((listener) => {
      try { listener(progress); } catch (_error) {}
    });
  }

  function onProgress(listener) {
    state.progressListeners.add(listener);
    if (state.lastProgress) {
      try { listener(state.lastProgress); } catch (_error) {}
    }
    return () => state.progressListeners.delete(listener);
  }

  init();

  function init() {
    injectStyle();
    watchForDialogs();
    window.setTimeout(() => {
      loadFolderIndex(false).catch(() => {});
    }, 3000);
  }

  function watchForDialogs() {
    scanDialogs();

    state.observer = new MutationObserver(() => {
      window.setTimeout(scanDialogs, CONFIG.refreshDelayMs);
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-expanded"],
    });
  }

  function scanDialogs() {
    const dialog = findSaveDialog();
    if (!dialog) {
      return;
    }
    if (dialog.querySelector(".yt-pan-search-root")) {
      return;
    }
    injectSearchUI(dialog);
  }

  function findSaveDialog() {
    const dialogs = queryAll(SELECTORS.dialog);
    for (const dialog of dialogs) {
      if (!isVisible(dialog)) {
        continue;
      }

      const text = sanitize(dialog.textContent || "");
      if (!/保存到|转存到|保存至/.test(text)) {
        continue;
      }

      if (!/确定/.test(text)) {
        continue;
      }

      return dialog;
    }
    return null;
  }

  function injectSearchUI(dialog) {
    const existing = dialog.querySelector(".yt-pan-search-root");
    if (existing) {
      existing.remove();
    }

    const root = document.createElement("div");
    root.className = "yt-pan-search-root";
    root.innerHTML = [
      '<div class="yt-pan-search-toolbar">',
      '<input class="yt-pan-search-input" type="text" placeholder="搜索我的网盘文件夹..." autocomplete="off" style="color: #1f2d3d !important; background: #fff !important; -webkit-text-fill-color: #1f2d3d !important;" />',
      '<button class="yt-pan-search-btn" type="button" data-action="refresh">刷新索引</button>',
      "</div>",
      '<div class="yt-pan-search-status">正在准备目录索引...</div>',
      '<div class="yt-pan-search-results"></div>',
    ].join("");

    const header = findFirst(dialog, SELECTORS.header);
    const body = findFirst(dialog, SELECTORS.body);
    if (header?.parentElement) {
      header.insertAdjacentElement("afterend", root);
    } else if (body?.parentElement) {
      body.insertAdjacentElement("beforebegin", root);
    } else {
      dialog.insertBefore(root, dialog.firstChild);
    }

    const input = root.querySelector(".yt-pan-search-input");
    const refreshBtn = root.querySelector('[data-action="refresh"]');
    const status = root.querySelector(".yt-pan-search-status");
    const results = root.querySelector(".yt-pan-search-results");

    const unsubscribe = onProgress((p) => {
      if (!document.body.contains(root)) {
        unsubscribe();
        return;
      }
      if (p.phase === "building") {
        status.textContent = `正在建立目录索引... 已扫描 ${p.folderCount} 个文件夹（队列剩余 ${p.pending}）${p.errorCount ? `，${p.errorCount} 个目录读取失败` : ""}`;
      }
    });

    input.addEventListener("focus", async () => {
      const query = sanitize(input.value);
      if (!query) {
        setResultsVisible(results, false);
        return;
      }
      setResultsVisible(results, true);
      const folders = await loadFolderIndex(false);
      renderResults(query, folders, results, status, dialog);
    });

    let lastQuery = "";
    let lastRenderQuery = "";
    let isComposing = false;

    const scheduleSearchRender = (query) => {
      clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(async () => {
        const folders = await loadFolderIndex(false);
        lastRenderQuery = query;
        renderResults(query, folders, results, status, dialog);
        if (input.value !== query) {
          input.value = query;
        }
      }, CONFIG.debounceMs);
    };

    input.addEventListener("compositionstart", () => {
      isComposing = true;
      clearTimeout(state.searchTimer);
    });

    input.addEventListener("compositionend", (event) => {
      isComposing = false;
      const query = event.target.value;
      lastQuery = query;
      scheduleSearchRender(query);
    });

    input.addEventListener("input", (event) => {
      if (event.isComposing || isComposing) {
        return;
      }

      const query = event.target.value;
      lastQuery = query;
      scheduleSearchRender(query);
    });

    // 百度弹窗刷新时可能重置输入框，这里持续兜底恢复。
    const keepAliveTimer = window.setInterval(() => {
      if (!document.body.contains(input)) {
        window.clearInterval(keepAliveTimer);
        return;
      }
      if (isComposing) {
        return;
      }
      if (lastQuery && input.value !== lastQuery) {
        input.value = lastQuery;
        input.style.color = "#1f2d3d";
        input.style.webkitTextFillColor = "#1f2d3d";

        if (lastRenderQuery !== lastQuery) {
          loadFolderIndex(false).then((folders) => {
            lastRenderQuery = lastQuery;
            renderResults(lastQuery, folders, results, status, dialog);
          });
        }
      }
    }, 120);

    const inputObserver = new MutationObserver(() => {
      if (isComposing) {
        return;
      }
      if (input.value !== lastQuery && lastQuery) {
        input.value = lastQuery;
      }
    });
    inputObserver.observe(input, {
      attributes: true,
      attributeFilter: ["value"],
      characterData: false,
      childList: false
    });

    const cleanup = () => {
      window.clearInterval(keepAliveTimer);
      inputObserver.disconnect();
    };

    const dialogObserver = new MutationObserver(() => {
      if (!document.body.contains(dialog)) {
        cleanup();
        dialogObserver.disconnect();
      }
    });
    dialogObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      const firstItem = results.querySelector(".yt-pan-search-item");
      if (firstItem) {
        firstItem.click();
      }
    });

    refreshBtn.addEventListener("click", async () => {
      status.textContent = "正在刷新目录索引，请稍候...";
      try {
        const folders = await loadFolderIndex(true);
        renderResults(input.value, folders, results, status, dialog);
        notify("目录索引已刷新完成");
      } catch (error) {
        status.textContent = `刷新失败：${error.message}`;
      }
    });

    loadFolderIndex(false).then((folders) => {
      renderResults(input.value, folders, results, status, dialog);
      input.focus();
      input.select();
    }).catch((error) => {
      status.textContent = `目录索引失败：${error.message}`;
    });
  }

  async function loadFolderIndex(forceRefresh) {
    if (!forceRefresh && Array.isArray(state.cachedFolders) && state.cachedFolders.length) {
      return state.cachedFolders;
    }

    if (!forceRefresh) {
      const cached = await readIndexCache();
      if (cached) {
        state.cachedFolders = cached;
        return cached;
      }
    }

    if (state.indexPromise && !forceRefresh) {
      return state.indexPromise;
    }

    state.indexPromise = buildFolderIndex().then(async (folders) => {
      state.cachedFolders = folders;
      await writeIndexCache(folders);
      return folders;
    }).finally(() => {
      state.indexPromise = null;
    });

    return state.indexPromise;
  }

  async function buildFolderIndex() {
    const folderMap = new Map();
    const queue = [{ path: "/", depth: 0 }];
    const errors = [];
    let active = 0;
    let scanned = 0;

    state.building = true;
    emitProgress({ folderCount: 0, scanned: 0, pending: 1, phase: "building" });

    return new Promise((resolve, reject) => {
      const pump = () => {
        if (!queue.length && active === 0) {
          state.building = false;
          const folders = sortFolders(Array.from(folderMap.values()));
          emitProgress({
            folderCount: folders.length,
            scanned,
            pending: 0,
            phase: "done",
            errorCount: errors.length,
          });

          if (folders.length === 0 && errors.length > 0) {
            reject(new Error(errors[0].message || "无法获取任何目录"));
            return;
          }
          resolve(folders);
          return;
        }

        while (active < CONFIG.concurrency && queue.length) {
          const current = queue.shift();
          active += 1;

          fetchDirectory(current.path)
            .then((folders) => {
              for (const folder of folders) {
                if (!folderMap.has(folder.path)) {
                  folderMap.set(folder.path, folder);
                }

                if (current.depth + 1 <= CONFIG.maxDepth) {
                  queue.push({ path: folder.path, depth: current.depth + 1 });
                }
              }
            })
            .catch((error) => {
              errors.push({ path: current.path, message: error.message });
              console.warn("[baidupan-search] 目录读取失败", current.path, error);
            })
            .then(() => {
              scanned += 1;
              active -= 1;
              emitProgress({
                folderCount: folderMap.size,
                scanned,
                pending: queue.length + active,
                phase: "building",
                errorCount: errors.length,
              });
              pump();
            });
        }
      };

      pump();
    });
  }

  async function fetchDirectory(dirPath) {
    const folders = [];
    let page = 1;

    while (true) {
      const payload = await requestJson(`/api/list?${new URLSearchParams({
        dir: dirPath,
        order: "name",
        desc: "0",
        num: String(CONFIG.pageSize),
        page: String(page),
        web: "1",
        showempty: "0",
        channel: "chunlei",
        app_id: "250528",
        clienttype: "0",
      }).toString()}`);

      const list = Array.isArray(payload.list) ? payload.list : [];

      for (const item of list) {
        if (!item || Number(item.isdir) !== 1) {
          continue;
        }
        folders.push({
          path: normalizePath(item.path || "/"),
          name: sanitize(item.server_filename || item.path || ""),
          parent: normalizePath(parentPath(item.path || "/")),
        });
      }

      if (list.length < CONFIG.pageSize) {
        break;
      }
      page += 1;
    }

    return folders;
  }

  async function requestJson(url, attempt = 0) {
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      if (typeof json.errno === "number" && json.errno !== 0) {
        throw new Error(`接口返回 errno=${json.errno}`);
      }
      return json;
    } catch (error) {
      if (attempt < CONFIG.retryCount) {
        await wait(CONFIG.retryDelayMs * (attempt + 1));
        return requestJson(url, attempt + 1);
      }
      throw error;
    }
  }

  function renderResults(query, folders, container, status, dialog) {
    const recentPaths = readRecentSelections();
    const items = searchFolders(query, folders, recentPaths);

    const rootElement = container.closest(".yt-pan-search-root");
    if (rootElement) {
      rootElement.dataset.lastQuery = query;
    }

    const summary = query
      ? `找到 ${items.length} 个匹配目录`
      : `索引完成，共 ${folders.length} 个文件夹`;

    status.textContent = summary;

    const searchInput = rootElement?.querySelector(".yt-pan-search-input");
    const savedValue = searchInput?.value || query;

    container.innerHTML = "";

    if (searchInput && savedValue) {
      searchInput.value = savedValue;
    }

    if (!sanitize(query)) {
      setResultsVisible(container, false);
      return;
    }

    if (!items.length) {
      container.innerHTML = '<div class="yt-pan-search-empty">没有匹配结果</div>';
      setResultsVisible(container, true);
      return;
    }

    const list = document.createElement("div");
    list.className = "yt-pan-search-list";

    items.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "yt-pan-search-item";
      button.innerHTML = [
        `<span class="yt-pan-search-item-name">${escapeHtml(item.name)}</span>`,
        `<span class="yt-pan-search-item-path">${escapeHtml(item.path)}</span>`,
      ].join("");

      button.addEventListener("click", async () => {
        status.textContent = `正在定位 ${item.path}`;
        setResultsVisible(container, false);
        try {
          await navigateDialogToPath(dialog, item.path);
          pushRecentSelection(item.path);
          status.textContent = `已定位到 ${item.path}，请确认后点击"确定"`;
        } catch (error) {
          status.textContent = `定位失败：${error.message}`;
          setResultsVisible(container, true);
        }
      });

      list.appendChild(button);
    });

    container.appendChild(list);
    setResultsVisible(container, true);
  }

  function searchFolders(query, folders, recentPaths) {
    const normalizedQuery = sanitize(query).toLowerCase();
    const recentSet = new Set(recentPaths);

    if (!normalizedQuery) {
      return [];
    }

    return folders
      .map((folder) => {
        const pathLower = folder.path.toLowerCase();
        const nameLower = folder.name.toLowerCase();
        let score = 0;

        if (nameLower === normalizedQuery) {
          score += 200;
        }
        if (nameLower.startsWith(normalizedQuery)) {
          score += 120;
        }
        if (nameLower.includes(normalizedQuery)) {
          score += 80;
        }
        if (pathLower.includes(normalizedQuery)) {
          score += 40;
        }
        if (recentSet.has(folder.path)) {
          score += 30;
        }
        score -= folder.path.length / 100;

        return { ...folder, score };
      })
      .filter((folder) => folder.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "zh-CN"))
      .slice(0, CONFIG.maxResults);
  }

  async function navigateDialogToPath(dialog, targetPath) {
    const normalizedTargetPath = normalizePath(targetPath);
    const segments = normalizedTargetPath.split("/").filter(Boolean);

    if (!segments.length) {
      return;
    }

    await resetDialogToRoot(dialog);
    await wait(400);

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const isLast = index === segments.length - 1;
      const expectedPath = `/${segments.slice(0, index + 1).join("/")}`;
      const nextSegment = !isLast ? segments[index + 1] : null;

      const node = await findNodeInDialog(dialog, segment);

      if (!node) {
        throw new Error(`未找到目录节点：${segment}`);
      }

      node.scrollIntoView({ block: "center" });
      await wait(200);

      const activated = await activateNodeInDialog(dialog, node, {
        expectedPath,
        nextSegment,
        isLast,
      });

      if (!activated) {
        throw new Error(`无法激活节点：${segment}`);
      }
    }
  }

  async function resetDialogToRoot(dialog) {
    // 先尝试通过根节点文本或面包屑回到顶层。
    const rootTexts = ["全部文件", "我的网盘", "根目录", "全部"];
    for (const text of rootTexts) {
      const rootAnchor = findVisibleTextNode(dialog, text);
      if (rootAnchor) {
        const clickable = findClickableTarget(rootAnchor);
        if (clickable) {
          clickable.scrollIntoView({ block: "center" });
          dispatchClick(clickable);
          await wait(400);
          return true;
        }
      }
    }

    const breadcrumbs = dialog.querySelectorAll('[class*="breadcrumb"], [class*="path"], [class*="crumb"]');
    for (const breadcrumb of breadcrumbs) {
      if (!isVisible(breadcrumb)) continue;
      const firstItem = breadcrumb.querySelector('a, span, button, [class*="item"]');
      if (firstItem && isVisible(firstItem)) {
        dispatchClick(firstItem);
        await wait(400);
        return true;
      }
    }

    const treeContainers = queryAll(SELECTORS.treeContainer, dialog);
    for (const container of treeContainers) {
      if (!isVisible(container)) continue;
      if (container instanceof HTMLElement) {
        container.scrollTop = 0;
        await wait(200);
        return true;
      }
    }

    return false;
  }

  async function findNodeInDialog(dialog, segment) {
    const roots = getTreeSearchRoots(dialog);
    if (!roots.length) {
      throw new Error("没有找到目录树容器");
    }

    for (const root of roots) {
      if (root instanceof HTMLElement) {
        root.scrollTop = 0;
      }
    }
    await wait(100);

    for (let attempt = 0; attempt < CONFIG.nodeSearchAttempts; attempt += 1) {
      const freshRoots = getTreeSearchRoots(dialog);
      const visibleNodes = [];

      for (const root of freshRoots) {
        const nodes = collectTreeNodes(root);

        visibleNodes.push(...nodes);
        const matched = findBestMatchingNode(nodes, segment);
        if (matched) {
          return matched;
        }
      }

      freshRoots.forEach(scrollTree);
      await wait(180);
    }

    return null;
  }

  function getTreeSearchRoots(dialog) {
    const body = findFirst(dialog, SELECTORS.body) || dialog;
    const candidates = queryAll(SELECTORS.treeContainer, body)
      .filter((node) => node instanceof HTMLElement && isVisible(node) && !node.closest(".yt-pan-search-root"));

    if (!candidates.length) {
      return [body];
    }

    const ranked = candidates
      .map((node) => ({
        node,
        score: scoreTreeRoot(node),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.node.clientHeight - a.node.clientHeight)
      .map((item) => item.node);

    return uniqueElements(ranked.length ? ranked : candidates);
  }

  function findBestMatchingNode(nodes, segment) {
    const exact = nodes.find((node) => matchesNodeSegment(node, segment, false));
    if (exact) {
      return exact;
    }
    return nodes.find((node) => matchesNodeSegment(node, segment, true)) || null;
  }

  function matchesNodeSegment(node, segment, allowLoose) {
    const normalizedSegment = sanitize(segment);
    const candidates = getNodeTextCandidates(node);

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      if (candidate === normalizedSegment) {
        return true;
      }

      const trimmedCandidate = candidate.replace(/\s+/g, '');
      const trimmedSegment = normalizedSegment.replace(/\s+/g, '');
      if (trimmedCandidate === trimmedSegment) {
        return true;
      }

      if (!allowLoose) {
        continue;
      }

      if (candidate.startsWith(`${normalizedSegment} `) ||
          candidate.endsWith(` ${normalizedSegment}`) ||
          candidate.includes(normalizedSegment)) {
        return true;
      }

      if (trimmedCandidate.includes(trimmedSegment)) {
        return true;
      }
    }

    return false;
  }

  function getNodeTextCandidates(node) {
    if (!(node instanceof HTMLElement)) {
      return [];
    }

    const candidates = [
      sanitize(node.getAttribute("title") || ""),
      sanitize(node.getAttribute("data-name") || ""),
      extractNodeName(node),
      sanitize(node.textContent || ""),
    ];
    return uniqueStrings(candidates.filter(Boolean));
  }

  async function waitForDialogPath(dialog, expectedPath, nextSegment) {
    for (let attempt = 0; attempt < CONFIG.pathVerifyAttempts; attempt += 1) {
      const pathMatched = dialogShowsPath(dialog, expectedPath);
      const nextVisible = nextSegment ? dialogCanSeeSegment(dialog, nextSegment) : false;
      if (pathMatched) {
        return true;
      }

      if (nextSegment && nextVisible) {
        return true;
      }

      await wait(200);
    }

    return false;
  }

  async function activateNodeInDialog(dialog, node, options) {
    const targets = uniqueElements([
      findNodeActionTarget(node),
      findClickableTarget(findFirst(node, SELECTORS.nodeLabel) || node),
      node,
    ]);

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const actionTarget = options.isLast
        ? (findNodeActionTarget(target) || target)
        : (findNodeExpandTarget(target) || findNodeExpandTarget(node) || target);
      actionTarget.scrollIntoView({ block: "center" });
      await wait(150);
      if (options.isLast) {
        clickNode(actionTarget);
      } else {
        dispatchSingleClick(actionTarget);
      }
      await wait(300);

      if (!options.isLast) {
        if (await waitForDialogPath(dialog, options.expectedPath, options.nextSegment)) {
          return true;
        }

        expandNode(actionTarget);
        await wait(450);

        if (await waitForDialogPath(dialog, options.expectedPath, options.nextSegment)) {
          return true;
        }
        continue;
      }

      // 最后一级补点两次，提升选中稳定性。
      clickNode(target);
      await wait(300);
      clickNode(target);
      await wait(300);

      if (await waitForDialogPath(dialog, options.expectedPath, "")) {
        return true;
      }
    }

    return false;
  }

  function expandNode(node) {
    if (!(node instanceof HTMLElement)) {
      return;
    }

    const expanded = node.getAttribute("aria-expanded");
    if (expanded === "true") {
      return;
    }

    const expander = findNodeExpandTarget(node);
    if (!expander) {
      return;
    }

    expander.scrollIntoView({ block: "center" });
    dispatchSingleClick(expander);
  }

  function clickNode(node) {
    if (!node) return;

    const directLabel = findDirectNodeLabel(node);
    const rowTarget = findClickableTarget(node) || node;

    if (directLabel && directLabel !== rowTarget) {
      dispatchClick(directLabel);
    }
    dispatchClick(rowTarget);
    if (node !== rowTarget) {
      dispatchClick(node);
    }

    // 设置焦点
    if (node instanceof HTMLElement && typeof node.focus === 'function') {
      try {
        node.focus();
      } catch (_error) {}
    }

    // 标记选中状态
    if (node instanceof HTMLElement) {
      node.setAttribute('aria-selected', 'true');
      node.classList.add('selected');
    }
  }

  function scrollTree(container) {
    if (!(container instanceof HTMLElement)) {
      return;
    }
    if (container.scrollHeight > container.clientHeight + 40) {
      container.scrollTop += Math.max(120, Math.floor(container.clientHeight * 0.6));
    }
  }

  function extractNodeName(node) {
    if (!(node instanceof HTMLElement)) {
      return "";
    }

    const title = sanitize(node.getAttribute("title") || "");
    if (title) {
      return title;
    }

    const dataName = sanitize(node.getAttribute("data-name") || "");
    if (dataName) {
      return dataName;
    }

    const label = findFirst(node, SELECTORS.nodeLabel);
    if (label) {
      const labelText = sanitize(label.textContent || "");
      if (labelText && labelText.length < 200) {
        return labelText;
      }
    }

    const directText = sanitize(node.textContent || "");
    if (directText && directText.length < 200 && node.children.length < 10) {
      return directText;
    }

    return "";
  }

  function collectTreeNodes(root) {
    if (!(root instanceof HTMLElement)) {
      return [];
    }

    const collected = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
      const row = findTreeNodeCandidate(candidate, root);
      if (!row || seen.has(row) || !isUsableTreeNode(row)) {
        return;
      }
      seen.add(row);
      collected.push(row);
    };

    queryAll(SELECTORS.nodeLabel, root).forEach(pushCandidate);
    queryAll(SELECTORS.treeNode, root).forEach(pushCandidate);
    return collected;
  }

  function findTreeNodeCandidate(node, root) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }

    const baiduTreeNode = node.closest(".treeview-node-handler, .treeview-node");
    if (baiduTreeNode instanceof HTMLElement && root.contains(baiduTreeNode)) {
      return baiduTreeNode;
    }

    const candidate = node.closest(
      '[role="treeitem"], [class*="tree-node"], [class*="tree-item"], [class*="node-item"], [class*="folder-item"], [data-type="folder"], [data-category="folder"], li[class*="item"], div[class*="item"], [class*="row"], li'
    );
    if (candidate instanceof HTMLElement && root.contains(candidate)) {
      return candidate;
    }
    return root.contains(node) ? node : null;
  }

  function isUsableTreeNode(node) {
    if (!(node instanceof HTMLElement) || !isVisible(node) || node.closest(".yt-pan-search-root")) {
      return false;
    }

    const name = extractNodeName(node);
    if (!name || name.length > 80) {
      return false;
    }

    const text = sanitize(node.textContent || "");
    if (!text || text.length > Math.max(120, name.length * 6)) {
      return false;
    }

    return true;
  }

  function scoreTreeRoot(node) {
    if (!(node instanceof HTMLElement)) {
      return 0;
    }

    const className = String(node.className || "").toLowerCase();
    let score = 0;
    if (node.getAttribute("role") === "tree") {
      score += 50;
    }
    if (className.includes("file-tree")) {
      score += 50;
    }
    if (className.includes("tree")) {
      score += 25;
    }
    if (className.includes("list")) {
      score += 10;
    }
    if (node.scrollHeight > node.clientHeight + 20) {
      score += 15;
    }
    if (collectTreeNodes(node).length >= 3) {
      score += 20;
    }
    return score;
  }

  function dialogCanSeeSegment(dialog, segment) {
    const roots = getTreeSearchRoots(dialog);
    return roots.some((root) => Boolean(findBestMatchingNode(collectTreeNodes(root), segment)));
  }

  function dialogShowsPath(dialog, expectedPath) {
    const cleanedPath = normalizePath(expectedPath).replace(/\s+/g, "");

    if (cleanedPath === "/") {
      return true;
    }

    const pathTexts = getDialogPathTexts(dialog);

    const hasFullPath = pathTexts.some((text) => {
      const cleanedText = sanitize(text).replace(/\s+/g, "");
      return cleanedText.includes(cleanedPath);
    });

    if (hasFullPath) {
      return true;
    }

    const segments = cleanedPath.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1];

    const hasLastSegment = pathTexts.some((text) => {
      const cleanedText = sanitize(text).replace(/\s+/g, "");
      return cleanedText.includes(lastSegment);
    });

    if (hasLastSegment) {
      return true;
    }

    const selectedNodes = dialog.querySelectorAll('[aria-selected="true"], .selected, [class*="selected"]');

    for (const node of selectedNodes) {
      const nodeText = sanitize(node.textContent || "").replace(/\s+/g, "");
      if (nodeText.includes(lastSegment)) {
        return true;
      }
    }

    return false;
  }

  function getDialogPathTexts(dialog) {
    return uniqueStrings(
      queryAll(SELECTORS.pathIndicator, dialog)
        .filter((element) => isVisible(element) && !element.closest(".yt-pan-search-root"))
        .map((element) => sanitize(element.textContent || ""))
        .filter((text) => text && text.length <= 200)
    );
  }

  function findVisibleTextNode(root, text) {
    const elements = Array.from(root.querySelectorAll("*"));
    return elements.find((element) => {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        return false;
      }
      return sanitize(element.textContent || "") === text;
    }) || null;
  }

  function findClickableTarget(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }

    if (
      node.matches('[role="treeitem"], [data-type="folder"], [data-category="folder"], li[class*="item"], div[class*="item"], [class*="row"], li')
    ) {
      return node;
    }

    return node.closest('[role="treeitem"], [data-type="folder"], [data-category="folder"], button, [role="button"], a, li[class*="item"], div[class*="item"], [class*="row"], li, [class*="name"], [class*="title"]');
  }

  function findNodeActionTarget(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }

    return findDirectNodeLabel(node) || findClickableTarget(node) || findClickableTarget(findFirst(node, SELECTORS.nodeLabel)) || node;
  }

  function findNodeExpandTarget(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }

    if (node.matches(".treeview-node-handler, .treeview-node")) {
      return node;
    }

    const inlineHandler = node.querySelector(".treeview-node-handler, .treeview-node");
    if (inlineHandler instanceof HTMLElement) {
      return inlineHandler;
    }

    const closestHandler = node.closest(".treeview-node-handler, .treeview-node");
    if (closestHandler instanceof HTMLElement) {
      return closestHandler;
    }

    return findDirectNodeLabel(node) || findClickableTarget(node) || node;
  }

  function findDirectNodeLabel(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }

    const nodeName = extractNodeName(node);
    const candidates = [
      ...node.querySelectorAll('[title], [data-name], [class*="name"], [class*="title"], a, span, div'),
    ];

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) {
        continue;
      }

      const text = sanitize(
        candidate.getAttribute("title") ||
        candidate.getAttribute("data-name") ||
        candidate.textContent ||
        ""
      );
      if (!text || text.length > 80) {
        continue;
      }

      if (!nodeName || text === nodeName || text.includes(nodeName) || nodeName.includes(text)) {
        return candidate;
      }
    }

    return null;
  }

  function dispatchClick(node) {
    if (!(node instanceof HTMLElement)) {
      return;
    }

    if (typeof node.focus === "function") {
      try {
        node.focus({ preventScroll: true });
      } catch (_error) {}
    }
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
    node.click();
  }

  function dispatchSingleClick(node) {
    if (!(node instanceof HTMLElement)) {
      return;
    }

    if (typeof node.focus === "function") {
      try {
        node.focus({ preventScroll: true });
      } catch (_error) {}
    }

    ["pointerdown", "mousedown", "mouseup"].forEach((type) => {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
    node.click();
  }

  function uniqueElements(values) {
    const seen = new Set();
    return values.filter((value) => {
      if (!(value instanceof Element) || seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
  }

  function setResultsVisible(container, visible) {
    if (!(container instanceof HTMLElement)) {
      return;
    }
    container.style.display = visible ? "block" : "none";
  }

  function uniqueStrings(values) {
    return Array.from(new Set(values.map((value) => sanitize(value)).filter(Boolean)));
  }

  async function readIndexCache() {
    const payload = await storeGet(CONFIG.cacheKey, null);
    if (!payload || !Array.isArray(payload.folders) || !payload.ts) {
      return null;
    }

    if (Date.now() - payload.ts > CONFIG.indexTTL) {
      return null;
    }

    return sortFolders(payload.folders);
  }

  async function writeIndexCache(folders) {
    await storeSet(CONFIG.cacheKey, {
      ts: Date.now(),
      folders,
    });
  }

  function readRecentSelections() {
    let payload;
    try {
      if (typeof GM_getValue === "function") {
        payload = GM_getValue(CONFIG.recentKey, []);
      }
    } catch (_error) {}
    if (payload === undefined) {
      payload = rawStoreGet(CONFIG.recentKey, []);
    }
    return Array.isArray(payload) ? payload : [];
  }

  function pushRecentSelection(path) {
    const current = readRecentSelections().filter((item) => item !== path);
    current.unshift(path);
    const trimmed = current.slice(0, 12);
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(CONFIG.recentKey, trimmed);
        return;
      }
    } catch (_error) {}
    rawStoreSet(CONFIG.recentKey, trimmed);
  }

  async function storeGet(key, fallbackValue) {
    try {
      if (typeof GM_getValue === "function") {
        const value = GM_getValue(key, fallbackValue);
        return value === undefined ? fallbackValue : value;
      }
    } catch (_error) {}

    return rawStoreGet(key, fallbackValue);
  }

  async function storeSet(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
        return;
      }
    } catch (_error) {}

    rawStoreSet(key, value);
  }

  function rawStoreGet(key, fallbackValue) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallbackValue;
    } catch (_error) {
      return fallbackValue;
    }
  }

  function rawStoreSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_error) {}
  }

  function notify(message) {
    try {
      if (typeof GM_notification === "function") {
        GM_notification({
          text: message,
          title: "百度网盘转存目录搜索",
          timeout: 2500,
        });
        return;
      }
    } catch (_error) {}
  }

  function sortFolders(folders) {
    return folders.slice().sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  }

  function parentPath(path) {
    const normalized = normalizePath(path);
    if (normalized === "/") {
      return "/";
    }
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return `/${parts.join("/")}`;
  }

  function normalizePath(path) {
    const cleaned = `/${String(path || "/").replace(/^\/+|\/+$/g, "")}`;
    return cleaned === "/" ? "/" : cleaned.replace(/\/{2,}/g, "/");
  }

  function sanitize(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function findFirst(root, selectors) {
    if (!(root instanceof Element || root instanceof Document)) {
      return null;
    }

    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) {
        return node;
      }
    }
    return null;
  }

  function queryAll(selectors, root = document) {
    const seen = new Set();
    const items = [];
    selectors.forEach((selector) => {
      root.querySelectorAll(selector).forEach((node) => {
        if (!seen.has(node)) {
          seen.add(node);
          items.push(node);
        }
      });
    });
    return items;
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return Boolean(
      style &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function injectStyle() {
    if (state.styleReady) {
      return;
    }

    const style = document.createElement("style");
    style.textContent = `
      .yt-pan-search-root {
        margin: 10px 18px 0;
        padding: 12px;
        border: 1px solid #e6eaf2;
        border-radius: 10px;
        background: #fff;
        box-shadow: 0 2px 8px rgba(17, 34, 68, 0.06);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      .yt-pan-search-toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .yt-pan-search-input {
        flex: 1 1 auto;
        height: 36px;
        padding: 0 12px;
        border: 1px solid #cfd6e4;
        border-radius: 8px;
        font-size: 14px;
        color: #1f2d3d !important;
        background: #fff !important;
        outline: none;
        box-sizing: border-box;
      }
      .yt-pan-search-input::placeholder {
        color: #99a3b3 !important;
      }
      .yt-pan-search-input:focus {
        border-color: #4f7cff;
        box-shadow: 0 0 0 3px rgba(79, 124, 255, 0.12);
      }
      .yt-pan-search-btn {
        flex: 0 0 auto;
        height: 36px;
        padding: 0 14px;
        border: 1px solid #d0d8e8;
        border-radius: 8px;
        background: #f7f9fc;
        color: #24324a;
        cursor: pointer;
      }
      .yt-pan-search-btn:hover {
        background: #eef4ff;
      }
      .yt-pan-search-status {
        margin-top: 8px;
        color: #66758f;
        font-size: 12px;
        line-height: 1.5;
      }
      .yt-pan-search-results {
        margin-top: 10px;
        max-height: 240px;
        overflow-y: auto;
      }
      .yt-pan-search-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .yt-pan-search-item {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid #ecf0f6;
        border-radius: 8px;
        background: #fff;
        text-align: left;
        cursor: pointer;
      }
      .yt-pan-search-item:hover {
        border-color: #bfd2ff;
        background: #f7faff;
      }
      .yt-pan-search-item-name {
        display: block;
        color: #1f2d3d;
        font-size: 13px;
        line-height: 1.5;
      }
      .yt-pan-search-item-path {
        display: block;
        margin-top: 2px;
        color: #7f8da3;
        font-size: 12px;
        line-height: 1.5;
        word-break: break-all;
      }
      .yt-pan-search-empty {
        padding: 10px 0;
        color: #7f8da3;
        font-size: 12px;
      }
    `;
    document.head.appendChild(style);
    state.styleReady = true;
  }
})();
