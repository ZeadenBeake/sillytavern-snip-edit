// Inline AI Edit — select text inside any chat message, describe an edit,
// and have the main API rewrite just that span in place.
//
// Paths below assume this file lives at:
//   public/scripts/extensions/third-party/inline-ai-edit/index.js
// (third-party extensions sit one directory deeper than built-ins, hence the extra "../").

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const MODULE_NAME = 'inline_ai_edit';

const defaultSettings = {
    enabled: true,
    contextChars: 300,
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    const settings = extension_settings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }
    return settings;
}

let toolbarEl = null;
let lastEdit = null; // { mesId, previousMes }

function removeToolbar() {
    if (toolbarEl) {
        toolbarEl.remove();
        toolbarEl = null;
    }
}

function getSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
    }

    const text = selection.toString().trim();
    if (!text) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const closestMesText = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('.mes_text');

    const startMesText = closestMesText(range.startContainer);
    const endMesText = closestMesText(range.endContainer);
    if (!startMesText || startMesText !== endMesText) {
        return null;
    }

    const mesEl = startMesText.closest('.mes[mesid]');
    if (!mesEl) {
        return null;
    }

    const mesId = Number(mesEl.getAttribute('mesid'));
    if (Number.isNaN(mesId)) {
        return null;
    }

    return { text, range: range.cloneRange(), mesTextEl: startMesText, mesId };
}

function showToolbar(info) {
    removeToolbar();

    const rect = info.range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
        return;
    }

    toolbarEl = document.createElement('div');
    toolbarEl.className = 'inline_ai_edit_toolbar';
    toolbarEl.innerHTML = '<button class="inline_ai_edit_btn" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Edit</button>';
    document.body.appendChild(toolbarEl);

    const top = window.scrollY + rect.top - toolbarEl.offsetHeight - 6;
    const left = window.scrollX + rect.left + (rect.width / 2) - (toolbarEl.offsetWidth / 2);
    toolbarEl.style.top = `${Math.max(top, window.scrollY + 4)}px`;
    toolbarEl.style.left = `${Math.max(left, window.scrollX + 4)}px`;

    // mousedown, not click: fires before the browser collapses the selection
    // on focus change, so `info` (captured at the original mouseup) stays valid.
    toolbarEl.querySelector('.inline_ai_edit_btn').addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openEditPopup(info);
    });
}

function escapeHtml(str) {
    return $('<div></div>').text(str).html();
}

async function openEditPopup(info) {
    removeToolbar();

    const content = `<p>Selected text:</p><div class="inline_ai_edit_preview">${escapeHtml(info.text)}</div><p>Describe the edit:</p>`;
    const instruction = await callGenericPopup(content, POPUP_TYPE.INPUT, '', {
        rows: 3,
        okButton: 'Rewrite',
        cancelButton: 'Cancel',
    });

    if (!instruction) {
        return;
    }

    await performEdit(info, String(instruction).trim());
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count++;
        idx += needle.length;
    }
    return count;
}

// The raw message is markdown/macro source; the selection comes from the
// rendered DOM, so a repeated snippet needs disambiguating. Heuristic: pick
// whichever raw-text occurrence sits closest to the selection's offset in the
// rendered plain text — good enough for plain prose, which is the common case.
function disambiguateOccurrence(rawMes, info) {
    const preRange = document.createRange();
    preRange.selectNodeContents(info.mesTextEl);
    preRange.setEnd(info.range.startContainer, info.range.startOffset);
    const approxStart = preRange.toString().length;

    let idx = rawMes.indexOf(info.text);
    let bestIdx = idx;
    let bestDiff = Math.abs(idx - approxStart);
    while (idx !== -1) {
        const diff = Math.abs(idx - approxStart);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = idx;
        }
        idx = rawMes.indexOf(info.text, idx + 1);
    }
    return bestIdx;
}

function cleanResult(raw) {
    if (!raw) return '';
    let text = String(raw).trim();

    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) {
        text = text.slice(1, -1).trim();
    }

    const fenceMatch = text.match(/^```(?:\w+)?\n([\s\S]*?)\n?```$/);
    if (fenceMatch) {
        text = fenceMatch[1].trim();
    }

    return text;
}

async function performEdit(info, instruction) {
    const context = getContext();
    const message = context.chat[info.mesId];
    if (!message) {
        toastr.error('Could not find that message anymore.');
        return;
    }

    const rawMes = message.mes;
    const occurrences = countOccurrences(rawMes, info.text);
    if (occurrences === 0) {
        toastr.warning('Could not locate the exact selected text in the raw message (it may contain markdown or macros). Try selecting plain text.');
        return;
    }

    const targetIndex = occurrences > 1 ? disambiguateOccurrence(rawMes, info) : rawMes.indexOf(info.text);

    const settings = getSettings();
    const contextChars = Math.max(0, Number(settings.contextChars) || 0);
    const contextBefore = contextChars > 0 ? rawMes.slice(Math.max(0, targetIndex - contextChars), targetIndex) : '';
    const contextAfter = contextChars > 0 ? rawMes.slice(targetIndex + info.text.length, targetIndex + info.text.length + contextChars) : '';

    const systemPrompt = [
        'You are a precise text-editing assistant embedded in a chat application.',
        'You will be given a SNIPPET of text taken from inside a larger message, and an EDIT INSTRUCTION describing how to change it.',
        'Rewrite the snippet according to the instruction.',
        'Output ONLY the replacement text: no preamble, no quotation marks, no explanations, no markdown code fences.',
        'Preserve the original language, point of view and tone unless the instruction says otherwise.',
        'If CONTEXT BEFORE/AFTER is provided, use it only to understand the snippet — do not repeat it in your output.',
    ].join(' ');

    const promptParts = [];
    if (contextBefore) promptParts.push(`CONTEXT BEFORE:\n${contextBefore}`);
    promptParts.push(`EDIT INSTRUCTION: ${instruction}`);
    promptParts.push(`SNIPPET TO REWRITE:\n${info.text}`);
    if (contextAfter) promptParts.push(`CONTEXT AFTER:\n${contextAfter}`);

    const toastId = toastr.info('Rewriting selection…', 'Inline AI Edit', { timeOut: 0, extendedTimeOut: 0 });

    try {
        const result = await context.generateRaw({ prompt: promptParts.join('\n\n'), systemPrompt });
        const replacement = cleanResult(result);

        toastr.clear(toastId);

        if (!replacement) {
            toastr.error('The model returned an empty response.');
            return;
        }

        lastEdit = { mesId: info.mesId, previousMes: rawMes };
        message.mes = rawMes.slice(0, targetIndex) + replacement + rawMes.slice(targetIndex + info.text.length);

        await eventSource.emit(event_types.MESSAGE_EDITED, info.mesId);
        context.updateMessageBlock(info.mesId, message);
        await eventSource.emit(event_types.MESSAGE_UPDATED, info.mesId);
        await context.saveChat();

        toastr.success('AI edit applied. Click to undo.', 'Inline AI Edit', {
            timeOut: 8000,
            onclick: () => undoLastEdit(),
        });
    } catch (error) {
        toastr.clear(toastId);
        console.error('[Inline AI Edit] generation failed', error);
        toastr.error(`Inline AI edit failed: ${error?.message ?? error}`);
    }
}

async function undoLastEdit() {
    if (!lastEdit) return;
    const context = getContext();
    const message = context.chat[lastEdit.mesId];
    if (!message) return;

    message.mes = lastEdit.previousMes;
    await eventSource.emit(event_types.MESSAGE_EDITED, lastEdit.mesId);
    context.updateMessageBlock(lastEdit.mesId, message);
    await eventSource.emit(event_types.MESSAGE_UPDATED, lastEdit.mesId);
    await context.saveChat();

    toastr.info('Reverted last AI edit.');
    lastEdit = null;
}

function registerSelectionListeners() {
    $(document).on('mouseup', (event) => {
        if (event.target.closest?.('.inline_ai_edit_toolbar')) {
            return;
        }
        setTimeout(() => {
            if (!getSettings().enabled) {
                removeToolbar();
                return;
            }
            const info = getSelectionInfo();
            if (info) {
                showToolbar(info);
            } else {
                removeToolbar();
            }
        }, 0);
    });

    $(document).on('mousedown', (event) => {
        if (!event.target.closest?.('.inline_ai_edit_toolbar')) {
            removeToolbar();
        }
    });

    $(document).on('keydown', (event) => {
        if (event.key === 'Escape') {
            removeToolbar();
        }
    });
}

function addSettingsUI() {
    const settings = getSettings();
    const html = `
    <div class="inline_ai_edit_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Inline AI Edit</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="inline_ai_edit_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                    Enable inline AI edit
                </label>
                <label>
                    Context characters sent for background (0 to disable)
                    <input id="inline_ai_edit_context_chars" type="number" min="0" step="50" value="${settings.contextChars}" class="text_pole">
                </label>
                <small>Highlight text inside any message, click the "Edit" button that appears, and describe the change you want. Works against whichever API/backend is currently selected.</small>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    $('#inline_ai_edit_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#inline_ai_edit_context_chars').on('input', function () {
        getSettings().contextChars = Number($(this).val()) || 0;
        saveSettingsDebounced();
    });
}

jQuery(() => {
    getSettings();
    addSettingsUI();
    registerSelectionListeners();
});
