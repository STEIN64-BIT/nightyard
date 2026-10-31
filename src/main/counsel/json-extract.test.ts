import { describe, it, expect } from 'vitest';
import { extractJsonObject } from './json-extract';

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips markdown fences', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('finds the first balanced object inside prose', () => {
    expect(extractJsonObject('Sure! Here you go: {"decision":"continue","note":""} hope that helps'))
      .toEqual({ decision: 'continue', note: '' });
  });
  it('handles braces inside strings', () => {
    expect(extractJsonObject('x {"note":"use {curly} braces","n":2} y'))
      .toEqual({ note: 'use {curly} braces', n: 2 });
  });
  it('handles escaped quotes inside strings', () => {
    expect(extractJsonObject('{"note":"he said \\"go\\""}')).toEqual({ note: 'he said "go"' });
  });
  it('returns null for garbage', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('{"unclosed":')).toBeNull();
  });
  it('returns null for JSON arrays (object required)', () => {
    expect(extractJsonObject('[1,2]')).toBeNull();
  });
  it('handles nested objects inside prose', () => {
    expect(extractJsonObject('result: {"decision":"stop","meta":{"score":5,"tags":{"a":1}}} done'))
      .toEqual({ decision: 'stop', meta: { score: 5, tags: { a: 1 } } });
  });
});
