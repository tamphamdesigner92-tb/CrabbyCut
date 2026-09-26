#!/usr/bin/env node
/**
 * GỘP BẢN DỊCH vào static/i18n/{en,zh}.json (docs/I18N.md).
 *   node scripts/i18n_merge.js fragment1.json [fragment2.json …]
 * Mỗi fragment: { "<câu tiếng Việt>": { "en": "…" | {one,other}, "zh": "…" }, … }
 * Khoá được chuẩn hoá khoảng trắng; từ điển ghi lại theo thứ tự khoá để diff gọn.
 * Khoá đã có mà bản dịch KHÁC -> fragment sau thắng, và in cảnh báo để người gộp xem lại.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const I18n = require(path.join(ROOT, 'static', 'js', 'i18n.js'));
const LOCALES = ['en', 'zh'];

function dictPath(loc) { return path.join(ROOT, 'static', 'i18n', `${loc}.json`); }

function load(loc) {
    try { return JSON.parse(fs.readFileSync(dictPath(loc), 'utf8')); } catch (_) { return {}; }
}

const dicts = Object.fromEntries(LOCALES.map((loc) => [loc, load(loc)]));
let added = 0;
let changed = 0;

process.argv.slice(2).forEach((file) => {
    const frag = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.entries(frag).forEach(([rawKey, value]) => {
        const key = I18n.normKey(rawKey);
        if (!key || !value || typeof value !== 'object') return;
        LOCALES.forEach((loc) => {
            if (value[loc] == null || value[loc] === '') return;
            const prev = dicts[loc][key];
            if (prev === undefined) added += 1;
            else if (JSON.stringify(prev) !== JSON.stringify(value[loc])) {
                changed += 1;
                console.warn(`[${loc}] đổi ${JSON.stringify(key)}: ${JSON.stringify(prev)} -> ${JSON.stringify(value[loc])}  (${path.basename(file)})`);
            }
            dicts[loc][key] = value[loc];
        });
    });
});

LOCALES.forEach((loc) => {
    const sorted = {};
    Object.keys(dicts[loc]).sort((a, b) => a.localeCompare(b, 'vi')).forEach((k) => { sorted[k] = dicts[loc][k]; });
    fs.writeFileSync(dictPath(loc), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
});
console.log(`Đã gộp: ${added} bản dịch mới, ${changed} bản dịch đổi.`);
