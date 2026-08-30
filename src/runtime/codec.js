'use strict';

/**
 * Codec built-ins ported from jsonata's `src/functions.js` —
 * `base64encode`/`base64decode` (Node `Buffer`, not jsonata's browser
 * `btoa`/`atob` fallback — jsonata2js targets Node >=18 only) and
 * `encodeUrl(Component)`/`decodeUrl(Component)` (native URI functions,
 * D3140 on malformed input).
 */

const { err } = require('./values');

function fn_base64encode(str) {
  if (str === undefined) return undefined;
  return Buffer.from(str, 'binary').toString('base64');
}

function fn_base64decode(str) {
  if (str === undefined) return undefined;
  return Buffer.from(str, 'base64').toString('binary');
}

function fn_encodeUrlComponent(str) {
  if (str === undefined) return undefined;
  try {
    return encodeURIComponent(str);
  } catch (e) {
    throw err('D3140', { value: str, functionName: 'encodeUrlComponent' });
  }
}

function fn_encodeUrl(str) {
  if (str === undefined) return undefined;
  try {
    return encodeURI(str);
  } catch (e) {
    throw err('D3140', { value: str, functionName: 'encodeUrl' });
  }
}

function fn_decodeUrlComponent(str) {
  if (str === undefined) return undefined;
  try {
    return decodeURIComponent(str);
  } catch (e) {
    throw err('D3140', { value: str, functionName: 'decodeUrlComponent' });
  }
}

function fn_decodeUrl(str) {
  if (str === undefined) return undefined;
  try {
    return decodeURI(str);
  } catch (e) {
    throw err('D3140', { value: str, functionName: 'decodeUrl' });
  }
}

module.exports = {
  fn_base64encode,
  fn_base64decode,
  fn_encodeUrlComponent,
  fn_encodeUrl,
  fn_decodeUrlComponent,
  fn_decodeUrl,
};
