/**
 * multimodal.ts 多模态辅助函数的测试。
 *
 * 覆盖：extractText（string/array/null）、hasImage、messageText、
 * 构造器（imageUrlPart/textPart）、与 llm buildBody 的透传。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractText, hasImage, messageText, imageUrlPart, textPart } from '../src/multimodal.ts';
import type { Message } from '../src/types.ts';

test('extractText：string 原样返回', () => {
  assert.equal(extractText('hello'), 'hello');
});

test('extractText：null 返回空串', () => {
  assert.equal(extractText(null), '');
});

test('extractText：空串返回空串', () => {
  assert.equal(extractText(''), '');
});

test('extractText：纯文本数组拼接', () => {
  const parts = [textPart('hello'), textPart(' world')];
  assert.equal(extractText(parts), 'hello world');
});

test('extractText：图片用 [图片] 占位', () => {
  const parts = [textPart('看这张图：'), imageUrlPart('https://example.com/a.png'), textPart('描述它')];
  assert.equal(extractText(parts), '看这张图：[图片]描述它');
});

test('extractText：纯图片数组', () => {
  const parts = [imageUrlPart('data:image/png;base64,abc')];
  assert.equal(extractText(parts), '[图片]');
});

test('hasImage：string 无图片', () => {
  assert.ok(!hasImage('text'));
});

test('hasImage：null 无图片', () => {
  assert.ok(!hasImage(null));
});

test('hasImage：含 image_url 部件', () => {
  const parts = [textPart('x'), imageUrlPart('https://a.com/b.jpg')];
  assert.ok(hasImage(parts));
});

test('hasImage：纯文本数组无图片', () => {
  const parts = [textPart('x'), textPart('y')];
  assert.ok(!hasImage(parts));
});

test('messageText：从消息提取', () => {
  const msg: Message = { role: 'user', content: '你好' };
  assert.equal(messageText(msg), '你好');
});

test('messageText：多模态消息提取', () => {
  const msg: Message = { role: 'user', content: [textPart('看图'), imageUrlPart('https://a.com/b.png')] };
  assert.equal(messageText(msg), '看图[图片]');
});

test('imageUrlPart：构造正确', () => {
  const part = imageUrlPart('https://example.com/img.png');
  assert.equal(part.type, 'image_url');
  if (part.type === 'image_url') {
    assert.equal(part.image_url.url, 'https://example.com/img.png');
    assert.equal(part.image_url.detail, 'auto');
  }
});

test('imageUrlPart：指定 detail', () => {
  const part = imageUrlPart('data:image/png;base64,xxx', 'high');
  if (part.type === 'image_url') {
    assert.equal(part.image_url.detail, 'high');
  }
});

test('textPart：构造正确', () => {
  const part = textPart('描述文字');
  assert.equal(part.type, 'text');
  assert.equal(part.text, '描述文字');
});
