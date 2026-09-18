const assert = require('assert');
const path = require('path');

const { normalizeMarkdownScript } = require(path.join(__dirname, '..', '..', 'static', 'js', 'script-markdown.js'));

function assertRangeText(cleanText, range) {
  assert.strictEqual(cleanText.slice(range.clean_start, range.clean_end), range.text);
}

{
  const result = normalizeMarkdownScript('**lactose**', { sourceName: 'case.md' });
  assert.strictEqual(result.clean_text, 'lactose');
  assert.strictEqual(result.metadata.source_type, 'md');
  assert.strictEqual(result.metadata.source_name, 'case.md');
  assert.strictEqual(result.metadata.notes.length, 0);
  assert.strictEqual(result.metadata.bold_ranges.length, 1);
  assert.strictEqual(result.metadata.bold_ranges[0].text, 'lactose');
  assertRangeText(result.clean_text, result.metadata.bold_ranges[0]);
}

{
  // Note (***) đứng riêng, tách khỏi bold (**) bằng khoảng trắng
  const result = normalizeMarkdownScript('***dấu x*** **co bóp quá mức**');
  assert.strictEqual(result.clean_text, 'co bóp quá mức');
  assert.strictEqual(result.metadata.notes.length, 1);
  assert.strictEqual(result.metadata.notes[0].text, 'dấu x');
  assert.strictEqual(result.metadata.bold_ranges.length, 1);
  assert.strictEqual(result.metadata.bold_ranges[0].text, 'co bóp quá mức');
  assertRangeText(result.clean_text, result.metadata.bold_ranges[0]);
}

{
  // Note (***) nằm bên trong bold (**), có khoảng trắng ngăn cách với dấu **
  const result = normalizeMarkdownScript('hay **co bóp ***dấu x*** trì trệ**');
  assert.strictEqual(result.clean_text, 'hay co bóp trì trệ');
  assert.strictEqual(result.metadata.notes.length, 1);
  assert.strictEqual(result.metadata.notes[0].text, 'dấu x');
  assert.strictEqual(result.metadata.bold_ranges.length, 1);
  assert.strictEqual(result.metadata.bold_ranges[0].text, 'co bóp trì trệ');
  assertRangeText(result.clean_text, result.metadata.bold_ranges[0]);
}

{
  // Note (***) đứng độc lập -> không còn nội dung, không có bold
  const result = normalizeMarkdownScript('***chỉ là ghi chú***');
  assert.strictEqual(result.clean_text, '');
  assert.strictEqual(result.metadata.notes.length, 1);
  assert.strictEqual(result.metadata.notes[0].text, 'chỉ là ghi chú');
  assert.strictEqual(result.metadata.bold_ranges.length, 0);
}

{
  const source = '\ufeffCó\u00a01\u00a0thành\u00a0phần **hạn\u00a0chế\u00a0tiêu\u00a0chảy**';
  const result = normalizeMarkdownScript(source);
  assert.strictEqual(result.clean_text, 'Có 1 thành phần hạn chế tiêu chảy');
  assert.strictEqual(result.metadata.bold_ranges.length, 1);
  assert.strictEqual(result.metadata.bold_ranges[0].text, 'hạn chế tiêu chảy');
  assertRangeText(result.clean_text, result.metadata.bold_ranges[0]);
}

{
  // Bold có sao thừa dính liền dấu đóng (typo "***") -> vẫn nhận bold, không nuốt thành note
  const result = normalizeMarkdownScript('cụm **GOS*** quan trọng ***ghi chú*** tiếp');
  assert.strictEqual(result.clean_text, 'cụm GOS quan trọng tiếp');
  assert.strictEqual(result.metadata.bold_ranges.length, 1);
  assert.strictEqual(result.metadata.bold_ranges[0].text, 'GOS');
  assert.strictEqual(result.metadata.notes.length, 1);
  assert.strictEqual(result.metadata.notes[0].text, 'ghi chú');
}

{
  // Dấu ** lẻ (typo) không được bắt cặp vắt qua dòng làm lệch các bold phía sau
  const result = normalizeMarkdownScript('a ** b\nsau đó **bold1** và **bold2**');
  assert.deepStrictEqual(result.metadata.bold_ranges.map((b) => b.text), ['bold1', 'bold2']);
}

{
  // ** đóng-mồ-côi theo sau là khoảng trắng không được coi là dấu mở mới
  const result = normalizeMarkdownScript('**dòng một\ndòng hai** rồi **bold2**');
  assert.deepStrictEqual(result.metadata.bold_ranges.map((b) => b.text), ['bold2']);
}

{
  const result = normalizeMarkdownScript('A **bold one** and **bold two**.');
  assert.strictEqual(result.clean_text, 'A bold one and bold two.');
  assert.strictEqual(result.metadata.bold_ranges.length, 2);
  for (const range of result.metadata.bold_ranges) {
    assertRangeText(result.clean_text, range);
  }
}

{
  // Ghi chú kiểu chú thích /* ... */ (định dạng .md mới): bỏ khỏi clean_text, giữ vị trí thật,
  // KHÔNG ảnh hưởng cụm in đậm cùng dòng.
  const result = normalizeMarkdownScript('Vì vậy, rất nhiều bé **không phải còi nên mới hay ốm.** /*CÂU HOOK (cắt trong vid)*/');
  assert.strictEqual(result.clean_text, 'Vì vậy, rất nhiều bé không phải còi nên mới hay ốm.');
  assert.strictEqual(result.metadata.notes.length, 1);
  assert.strictEqual(result.metadata.notes[0].text, 'CÂU HOOK (cắt trong vid)');
  assert.strictEqual(result.metadata.notes[0].line, 1);
  assert.strictEqual(result.metadata.bold_ranges.length, 1);
  assert.strictEqual(result.metadata.bold_ranges[0].text, 'không phải còi nên mới hay ốm.');
  assertRangeText(result.clean_text, result.metadata.bold_ranges[0]);
}

{
  // /* ... */ nội dung có dấu '/' bên trong vẫn đóng đúng ở '*/' đầu tiên; vị trí dòng được ghi nhớ.
  const result = normalizeMarkdownScript('Dòng một\nĐặc biệt là **giai đoạn mới đi lớp.** /*bé đi học, chơi với các bạn*/');
  assert.strictEqual(result.clean_text, 'Dòng một\nĐặc biệt là giai đoạn mới đi lớp.');
  assert.strictEqual(result.metadata.notes.length, 1);
  assert.strictEqual(result.metadata.notes[0].text, 'bé đi học, chơi với các bạn');
  assert.strictEqual(result.metadata.notes[0].line, 2);
  assert.strictEqual(result.metadata.bold_ranges[0].text, 'giai đoạn mới đi lớp.');
  assertRangeText(result.clean_text, result.metadata.bold_ranges[0]);
}

{
  // /* không có */ đóng -> coi như văn bản thường, không nuốt phần còn lại.
  const result = normalizeMarkdownScript('a /* chưa đóng ghi chú');
  assert.strictEqual(result.clean_text, 'a /* chưa đóng ghi chú');
  assert.strictEqual(result.metadata.notes.length, 0);
}

console.log('script markdown parser ok');
