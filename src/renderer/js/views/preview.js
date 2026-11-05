import { api, esc, formatSize, icon } from '../api.js';
import { motion } from '../motion.js';
import { toast, setBusy } from '../components/ui.js';

const els = () => ({
  sheet: document.getElementById('previewSheet'),
  scrim: document.getElementById('scrim'),
  body: document.getElementById('previewBody'),
  sub: document.getElementById('previewSub'),
  meta: document.getElementById('previewMeta'),
  confirm: document.getElementById('confirmOrganize'),
  cancel: document.getElementById('cancelPreview'),
  close: document.getElementById('closePreview'),
  progress: document.getElementById('previewProgress'),
  bar: document.getElementById('progressBar'),
  text: document.getElementById('progressText'),
});

/** 按目标文件夹分组渲染计划，每组显示数量与体积 */
function planHtml(plan, categoryById) {
  const groups = new Map();
  for (const item of plan.items) {
    if (!groups.has(item.folder)) groups.set(item.folder, []);
    groups.get(item.folder).push(item);
  }

  const order = [...categoryById.keys()];
  const blocks = [...groups.entries()]
    .sort((a, b) => order.indexOf(a[1][0].categoryId) - order.indexOf(b[1][0].categoryId))
    .map(([folder, items]) => {
    const rows = items
      .map((item) => {
        const cat = categoryById.get(item.categoryId);
        return `
          <label class="plan-row">
            <input class="plan-check" type="checkbox" checked data-name="${esc(item.name)}" />
            <span class="plan-row__icon tone-${esc(cat?.tone || 'gray')}">${icon(cat?.icon || 'file')}</span>
            <span class="plan-row__name" title="${esc(item.name)}">${esc(item.name)}</span>
            ${item.conflict ? '<span class="plan-row__tag">重名自动编号</span>' : ''}
            <span class="plan-row__size">${formatSize(item.size)}</span>
          </label>`;
      })
      .join('');
    const total = items.reduce((sum, item) => sum + item.size, 0);
    return `
      <div class="plan-group">
        <div class="plan-group__head">
          ${icon('folder')}<strong>${esc(folder)}</strong>
          <span class="plan-group__count">${items.length} 个 · ${formatSize(total)}</span>
        </div>
        ${rows}
      </div>`;
  });

  const skipped = plan.skipped.length
    ? `<p class="sheet__sub">已跳过 ${plan.skipped.length} 个：${esc(
        [...new Set(plan.skipped.map((row) => row.reason))].join('、'),
      )}</p>`
    : '';

  return `
    <div class="plan-group">
      <label class="plan-row">
        <input type="checkbox" id="planAll" checked />
        <span class="plan-row__name">全选 · ${plan.items.length} 个文件，共 ${formatSize(plan.summary.totalSize)}</span>
      </label>
    </div>
    ${blocks.join('')}
    ${skipped}`;
}

/**
 * 单张卡片飞入侧栏分类：弧线轨迹 + 落点图标轻跳。
 * 原则 7（弧线）+ 原则 8（次要动作）+ 原则 3（其余卡片后退）。
 */
async function flyCard(card, categoryId) {
  const target = document.querySelector(`.nav__item[data-category="${CSS.escape(categoryId)}"]`);
  if (!card || !card.isConnected || !target) return;

  const from = card.getBoundingClientRect();
  card.classList.add('is-flying');
  card.style.left = `${from.left}px`;
  card.style.top = `${from.top}px`;
  card.style.width = `${from.width}px`;
  card.style.height = `${from.height}px`;

  const grid = card.closest('.grid');
  const restore = grid ? motion.stage(grid, card) : () => {};
  const to = target.getBoundingClientRect();

  await Promise.resolve(motion.arcTo(card, from, to).finished).catch(() => {});
  restore();
  card.remove();
  motion.pulse(target.querySelector('.nav__dot'));
}

/**
 * 打开预览抽屉并执行整理。
 * @param {object} state 渲染层状态（dir / categories）
 * @param {{refresh:Function}} hooks 执行完成后的刷新回调
 */
export async function openPreview(state, hooks) {
  if (!state.dir) {
    toast('先选择一个文件夹', { type: 'warn' });
    return;
  }

  const ui = els();
  const categoryById = new Map(state.categories.map((cat) => [cat.id, cat]));
  ui.confirm.disabled = true;
  ui.body.innerHTML = '<div class="skeleton" style="height:60px"></div>';
  ui.sub.textContent = '正在扫描…';
  ui.progress.hidden = true;

  let plan;
  try {
    plan = await api.preview(state.dir);
  } catch (err) {
    toast(`预览失败：${err.message}`, { type: 'error' });
    return;
  }

  if (!plan.items.length) {
    toast(plan.skipped.length ? '这批文件都被跳过了（隐藏 / 临时文件）' : '这个文件夹不需要整理', { type: 'ok' });
    hooks.refresh?.();
    return;
  }

  ui.body.innerHTML = planHtml(plan, categoryById);
  ui.sub.textContent = '确认后才会移动文件，随时可以撤销';
  ui.meta.textContent = `${plan.summary.moveCount} 个文件 · ${formatSize(plan.summary.totalSize)}`;
  ui.confirm.disabled = false;
  ui.bar.style.width = '0%';
  ui.text.textContent = `0 / ${plan.summary.moveCount}`;

  const allBox = ui.body.querySelector('#planAll');
  const boxes = () => [...ui.body.querySelectorAll('.plan-check')];
  allBox?.addEventListener('change', () => {
    boxes().forEach((box) => {
      if (box.checked !== allBox.checked) box.checked = allBox.checked;
    });
  });
  boxes().forEach((box) =>
    box.addEventListener('change', () => {
      if (allBox) allBox.checked = boxes().every((item) => item.checked);
    }),
  );

  motion.open(ui.sheet, ui.scrim);

  // 每次打开重新绑定，关闭时统一解绑，避免监听器堆积
  const controller = new AbortController();
  const { signal } = controller;

  const closeSheet = async () => {
    controller.abort();
    await motion.close(ui.sheet, ui.scrim);
  };

  ui.cancel.addEventListener('click', closeSheet, { signal });
  ui.close.addEventListener('click', closeSheet, { signal });
  ui.scrim.addEventListener('click', closeSheet, { signal });

  ui.confirm.addEventListener(
    'click',
    async () => {
      const names = boxes().filter((box) => box.checked).map((box) => box.dataset.name);
      if (!names.length) {
        toast('至少选择一个文件', { type: 'warn' });
        return;
      }

      // 执行前先记下卡片节点，执行后仍可用它们播放飞入动画
      const flying = names
        .map((name) => plan.items.find((item) => item.name === name))
        .filter(Boolean)
        .slice(0, 6)
        .map((item) => ({
          categoryId: item.categoryId,
          card: document.querySelector(`.card[data-path="${CSS.escape(item.path)}"]`),
        }))
        .filter((row) => row.card);

      setBusy(ui.confirm, true, '整理中…');
      ui.progress.hidden = false;

      const unsubscribe = api.onProgress((progress) => {
        const ratio = progress.total ? progress.index / progress.total : 0;
        ui.bar.style.width = `${Math.round(ratio * 100)}%`;
        ui.text.textContent = `${progress.index} / ${progress.total}`;
      });

      try {
        const result = await api.execute(state.dir, names);
        unsubscribe();

        ui.bar.style.width = '100%';
        ui.text.textContent = `${result.moved} / ${result.total}`;
        motion.bump(ui.text, 0.8);

        for (const row of flying) {
          // eslint-disable-next-line no-await-in-loop
          await flyCard(row.card, row.categoryId);
        }

        await new Promise((resolve) => setTimeout(resolve, 200));

        if (result.failed.length) {
          toast(`整理完成 ${result.moved} 个，${result.failed.length} 个失败：${result.failed[0].reason}`, {
            type: 'warn',
            duration: 4200,
          });
        } else {
          toast(`已整理 ${result.moved} 个文件，可随时撤销`, { type: 'ok' });
        }

        await closeSheet();
        hooks.refresh?.();
      } catch (err) {
        unsubscribe();
        toast(`整理失败：${err.message}`, { type: 'error' });
      } finally {
        setBusy(ui.confirm, false);
        ui.progress.hidden = true;
      }
    },
    { signal },
  );
}
