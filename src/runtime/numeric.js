'use strict';

/**
 * Numeric built-ins ported from jsonata's `src/functions.js` — `number`,
 * `abs`, `floor`, `ceil`, `round`, `sqrt`, `power`, `random`, `formatNumber`
 * (XPath 3.1 F&O `fn:format-number` picture-string algorithm, ported
 * verbatim including every D308x validation error), and `formatBase`.
 *
 * Adaptation: none of these upstream functions use `this`/HOF plumbing or
 * async matcher protocol, so this is a near-literal copy operating on
 * already-evaluated native JS values, throwing `JsonataEvaluationError` (via
 * `values.err`) instead of jsonata's bare `throw {code, ...}` object literals.
 */

const { err } = require('./values');

/**
 * Cast `arg` to a number per `$number()`: numbers pass through; strings
 * matching a decimal-literal or a `0x`/`0o`/`0b` prefixed integer literal
 * parse; `true`/`false` cast to `1`/`0`; anything else throws D3030.
 */
function fn_number(arg) {
  if (arg === undefined) return undefined;

  if (typeof arg === 'number') {
    return arg;
  }
  if (
    typeof arg === 'string' &&
    /^-?[0-9]+(\.[0-9]+)?([Ee][-+]?[0-9]+)?$/.test(arg) &&
    !isNaN(parseFloat(arg)) &&
    isFinite(arg)
  ) {
    return parseFloat(arg);
  }
  if (typeof arg === 'string' && /^(0[xX][0-9A-Fa-f]+)|(0[oO][0-7]+)|(0[bB][0-1]+)$/.test(arg)) {
    return Number(arg);
  }
  if (arg === true) return 1;
  if (arg === false) return 0;

  throw err('D3030', { value: arg });
}

function fn_abs(arg) {
  if (arg === undefined) return undefined;
  return Math.abs(arg);
}

function fn_floor(arg) {
  if (arg === undefined) return undefined;
  return Math.floor(arg);
}

function fn_ceil(arg) {
  if (arg === undefined) return undefined;
  return Math.ceil(arg);
}

/**
 * Shifts `value`'s decimal exponent by `by` through the number's own decimal
 * string rather than `value * 10 ** by`, so no float-multiplication noise is
 * introduced (`8.835 * 100` is `883.4999999999999`, but `8.835e2` is exactly
 * `883.5`, which is what round-half-to-even must see). jsonata does the same
 * with `String.prototype.split('e')`; scanning for the exponent with
 * `indexOf` instead avoids allocating an array plus its substrings on every
 * call — `$round(x, n)` is one of the hottest built-ins in an analytical
 * expression (10.8% of evaluation self time in docs/design/performance.md's profile).
 */
function shiftDecimalExponent(value, by) {
  const s = value.toString();
  const e = s.indexOf('e');
  if (e === -1) return +(s + 'e' + by);
  return +(s.slice(0, e) + 'e' + (+s.slice(e + 1) + by));
}

/** `10^p` for the precisions the fast path below accepts (all exactly representable). */
const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];

/**
 * Round-half-to-even (banker's rounding) to `precision` decimal places
 * (default 0). `precision === 0` is falsy, so (matching upstream) the shift
 * step is skipped for precision 0 same as no precision at all.
 *
 * The decimal-string shift is exact but costs a number->string->number
 * round trip twice per call, which profiling put at ~10% of a formatting-heavy
 * expression's evaluation time. Scaling by a power of ten in floating point
 * instead is only equivalent when the scaled value is not near a tie, since
 * that is precisely where the string's exact decimal and the float product
 * disagree (`8.835` is really `8.83499999999999996…`, so `8.835e2` is `883.5`
 * while `8.835 * 100` is `883.4999999999999`). The guard below takes the float
 * path only when:
 *   - `1 <= precision <= 15`, so `10^precision` is exact;
 *   - `|scaled| < 1e9`, so one ulp is below 2.4e-7 and the total error from
 *     the multiplication *and* from `arg` itself differing from its shortest
 *     decimal form stays under ~5e-7;
 *   - the scaled value's distance from a `.5` tie exceeds 1e-6, i.e. more than
 *     that error bound, so both paths round to the same integer and neither
 *     triggers the half-to-even adjustment.
 * Unscaling by division is *always* safe: for an integer result and an exact
 * power of ten, IEEE division and parsing `"<int>e-<p>"` are both the
 * correctly-rounded double of the same rational, hence bit-identical.
 * `test/unit/round-fast-path.test.js` checks the equivalence over the tie
 * cases and 200k randomized values.
 */
function fn_round(arg, precision) {
  if (arg === undefined) return undefined;

  if (precision >= 1 && precision <= 15 && Number.isInteger(precision)) {
    const scaled = arg * POW10[precision];
    if (scaled > -1e9 && scaled < 1e9) {
      const frac = scaled - Math.floor(scaled);
      if (frac > 0.500001 || frac < 0.499999) {
        const rounded = Math.round(scaled) / POW10[precision];
        return rounded === 0 ? 0 : rounded; // JSON doesn't do -0
      }
    }
  }

  if (precision) arg = shiftDecimalExponent(arg, precision);

  let result = Math.round(arg);
  const diff = result - arg;
  if (Math.abs(diff) === 0.5 && Math.abs(result % 2) === 1) {
    // rounded the wrong way - adjust to nearest even number
    result = result - 1;
  }

  if (precision) result = shiftDecimalExponent(result, -precision);

  // JSON doesn't do -0
  return Object.is(result, -0) ? 0 : result;
}

function fn_sqrt(arg) {
  if (arg === undefined) return undefined;
  if (arg < 0) {
    throw err('D3060', { value: arg });
  }
  return Math.sqrt(arg);
}

function fn_power(arg, exp) {
  if (arg === undefined) return undefined;

  const result = Math.pow(arg, exp);
  if (!isFinite(result)) {
    throw err('D3061', { value: arg, exp });
  }
  return result;
}

function fn_random() {
  return Math.random();
}

/**
 * Formats `value` per XPath 3.1 F&O `fn:format-number`, ported verbatim
 * (bullets 1-14 of the spec algorithm, decimal-format `options` override,
 * and every D308x validation error).
 */
function fn_formatNumber(value, picture, options) {
  if (value === undefined) return undefined;
  const { properties, decimalDigitFamily, variables } = analyseNumberPicture(picture, options);
  const minus_sign = properties['minus-sign'];
  const zero_digit = properties['zero-digit'];
  const decimal_separator = properties['decimal-separator'];
  const grouping_separator = properties['grouping-separator'];
  return formatWithPicture(value, properties, decimalDigitFamily, variables,
    minus_sign, zero_digit, decimal_separator, grouping_separator);
}

// Bounded cache for the picture-analysis half of `$formatNumber`
// (jsonata2js.md P-1): splitting, validating and analysing the picture -
// which the XPath algorithm does before it looks at the value at all -
// depends only on `picture` and `options`, yet ran on every call, so
// `$formatNumber` inside a `$map` paid it per row. Cached entries are
// READ-ONLY; nothing downstream of `analyse` mutates them.
const { BoundedCache } = require('./bounded-cache');
const _numPictureCache = new BoundedCache();

/** Stable cache key for the (picture, options) pair; `null` when `options` can't be keyed safely. */
function numberPictureKey(picture, options) {
  if (options === undefined) return String(picture) + '\u0000';
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return null;
  const keys = Object.keys(options).sort();
  let key = String(picture) + '\u0000';
  for (const k of keys) {
    const v = options[k];
    if (typeof v !== 'string') return null;
    key += k + '\u0001' + v + '\u0002';
  }
  return key;
}

function analyseNumberPicture(picture, options) {
  const key = numberPictureKey(picture, options);
  if (key === null) return analyseNumberPictureUncached(picture, options);
  return _numPictureCache.get(key, () => analyseNumberPictureUncached(picture, options));
}

function analyseNumberPictureUncached(picture, options) {
  const defaults = {
    'decimal-separator': '.',
    'grouping-separator': ',',
    'exponent-separator': 'e',
    infinity: 'Infinity',
    'minus-sign': '-',
    NaN: 'NaN',
    percent: '%',
    'per-mille': '\u2030',
    'zero-digit': '0',
    digit: '#',
    'pattern-separator': ';',
  };

  // if `options` is specified, then its entries override defaults
  const properties = defaults;
  if (options !== undefined) {
    Object.keys(options).forEach((key) => {
      properties[key] = options[key];
    });
  }

  const decimalDigitFamily = [];
  const zeroCharCode = properties['zero-digit'].charCodeAt(0);
  for (let ii = zeroCharCode; ii < zeroCharCode + 10; ii++) {
    decimalDigitFamily.push(String.fromCharCode(ii));
  }

  const activeChars = decimalDigitFamily.concat([
    properties['decimal-separator'],
    properties['exponent-separator'],
    properties['grouping-separator'],
    properties.digit,
    properties['pattern-separator'],
  ]);

  const subPictures = picture.split(properties['pattern-separator']);

  if (subPictures.length > 2) {
    throw err('D3080');
  }

  const splitParts = function (subpicture) {
    const prefix = (function () {
      let ch;
      for (let ii = 0; ii < subpicture.length; ii++) {
        ch = subpicture.charAt(ii);
        if (activeChars.indexOf(ch) !== -1 && ch !== properties['exponent-separator']) {
          return subpicture.substring(0, ii);
        }
      }
      return '';
    })();
    const suffix = (function () {
      let ch;
      for (let ii = subpicture.length - 1; ii >= 0; ii--) {
        ch = subpicture.charAt(ii);
        if (activeChars.indexOf(ch) !== -1 && ch !== properties['exponent-separator']) {
          return subpicture.substring(ii + 1);
        }
      }
      return '';
    })();
    const activePart = subpicture.substring(prefix.length, subpicture.length - suffix.length);
    let mantissaPart, exponentPart, integerPart, fractionalPart;
    const exponentPosition = subpicture.indexOf(properties['exponent-separator'], prefix.length);
    if (exponentPosition === -1 || exponentPosition > subpicture.length - suffix.length) {
      mantissaPart = activePart;
      exponentPart = undefined;
    } else {
      mantissaPart = activePart.substring(0, exponentPosition);
      exponentPart = activePart.substring(exponentPosition + 1);
    }
    const decimalPosition = mantissaPart.indexOf(properties['decimal-separator']);
    if (decimalPosition === -1) {
      integerPart = mantissaPart;
      fractionalPart = suffix;
    } else {
      integerPart = mantissaPart.substring(0, decimalPosition);
      fractionalPart = mantissaPart.substring(decimalPosition + 1);
    }
    return {
      prefix,
      suffix,
      activePart,
      mantissaPart,
      exponentPart,
      integerPart,
      fractionalPart,
      subpicture,
    };
  };

  // validate the picture string, F&O 4.7.3
  const validate = function (parts) {
    let error;
    let ii;
    const subpicture = parts.subpicture;
    const decimalPos = subpicture.indexOf(properties['decimal-separator']);
    if (decimalPos !== subpicture.lastIndexOf(properties['decimal-separator'])) {
      error = 'D3081';
    }
    if (subpicture.indexOf(properties.percent) !== subpicture.lastIndexOf(properties.percent)) {
      error = 'D3082';
    }
    if (subpicture.indexOf(properties['per-mille']) !== subpicture.lastIndexOf(properties['per-mille'])) {
      error = 'D3083';
    }
    if (subpicture.indexOf(properties.percent) !== -1 && subpicture.indexOf(properties['per-mille']) !== -1) {
      error = 'D3084';
    }
    let valid = false;
    for (ii = 0; ii < parts.mantissaPart.length; ii++) {
      const ch = parts.mantissaPart.charAt(ii);
      if (decimalDigitFamily.indexOf(ch) !== -1 || ch === properties.digit) {
        valid = true;
        break;
      }
    }
    if (!valid) {
      error = 'D3085';
    }
    const charTypes = parts.activePart
      .split('')
      .map((char) => (activeChars.indexOf(char) === -1 ? 'p' : 'a'))
      .join('');
    if (charTypes.indexOf('p') !== -1) {
      error = 'D3086';
    }
    if (decimalPos !== -1) {
      if (
        subpicture.charAt(decimalPos - 1) === properties['grouping-separator'] ||
        subpicture.charAt(decimalPos + 1) === properties['grouping-separator']
      ) {
        error = 'D3087';
      }
    } else if (parts.integerPart.charAt(parts.integerPart.length - 1) === properties['grouping-separator']) {
      error = 'D3088';
    }
    if (subpicture.indexOf(properties['grouping-separator'] + properties['grouping-separator']) !== -1) {
      error = 'D3089';
    }
    let optionalDigitPos = parts.integerPart.indexOf(properties.digit);
    if (
      optionalDigitPos !== -1 &&
      parts.integerPart
        .substring(0, optionalDigitPos)
        .split('')
        .filter((char) => decimalDigitFamily.indexOf(char) > -1).length > 0
    ) {
      error = 'D3090';
    }
    optionalDigitPos = parts.fractionalPart.lastIndexOf(properties.digit);
    if (
      optionalDigitPos !== -1 &&
      parts.fractionalPart
        .substring(optionalDigitPos)
        .split('')
        .filter((char) => decimalDigitFamily.indexOf(char) > -1).length > 0
    ) {
      error = 'D3091';
    }
    const exponentExists = typeof parts.exponentPart === 'string';
    if (
      exponentExists &&
      parts.exponentPart.length > 0 &&
      (subpicture.indexOf(properties.percent) !== -1 || subpicture.indexOf(properties['per-mille']) !== -1)
    ) {
      error = 'D3092';
    }
    if (
      exponentExists &&
      (parts.exponentPart.length === 0 ||
        parts.exponentPart.split('').filter((char) => decimalDigitFamily.indexOf(char) === -1).length > 0)
    ) {
      error = 'D3093';
    }
    if (error) {
      throw err(error);
    }
  };

  // analyse the picture string, F&O 4.7.4
  const analyse = function (parts) {
    const getGroupingPositions = function (part, toLeft) {
      const positions = [];
      let groupingPosition = part.indexOf(properties['grouping-separator']);
      while (groupingPosition !== -1) {
        const charsToTheRight = (toLeft ? part.substring(0, groupingPosition) : part.substring(groupingPosition))
          .split('')
          .filter((char) => decimalDigitFamily.indexOf(char) !== -1 || char === properties.digit).length;
        positions.push(charsToTheRight);
        groupingPosition = parts.integerPart.indexOf(properties['grouping-separator'], groupingPosition + 1);
      }
      return positions;
    };
    const integerPartGroupingPositions = getGroupingPositions(parts.integerPart);
    const regular = function (indexes) {
      // are the grouping positions regular? i.e. same interval between each of them
      if (indexes.length === 0) {
        return 0;
      }
      const gcd = function (a, b) {
        return b === 0 ? a : gcd(b, a % b);
      };
      // find the greatest common divisor of all the positions
      const factor = indexes.reduce(gcd);
      // is every position separated by this divisor? If so, it's regular
      for (let index = 1; index <= indexes.length; index++) {
        if (indexes.indexOf(index * factor) === -1) {
          return 0;
        }
      }
      return factor;
    };

    const regularGrouping = regular(integerPartGroupingPositions);
    const fractionalPartGroupingPositions = getGroupingPositions(parts.fractionalPart, true);

    let minimumIntegerPartSize = parts.integerPart.split('').filter((char) => decimalDigitFamily.indexOf(char) !== -1).length;
    const scalingFactor = minimumIntegerPartSize;

    const fractionalPartArray = parts.fractionalPart.split('');
    let minimumFactionalPartSize = fractionalPartArray.filter((char) => decimalDigitFamily.indexOf(char) !== -1).length;
    let maximumFactionalPartSize = fractionalPartArray.filter(
      (char) => decimalDigitFamily.indexOf(char) !== -1 || char === properties.digit
    ).length;
    const exponentPresent = typeof parts.exponentPart === 'string';
    if (minimumIntegerPartSize === 0 && maximumFactionalPartSize === 0) {
      if (exponentPresent) {
        minimumFactionalPartSize = 1;
        maximumFactionalPartSize = 1;
      } else {
        minimumIntegerPartSize = 1;
      }
    }
    if (exponentPresent && minimumIntegerPartSize === 0 && parts.integerPart.indexOf(properties.digit) !== -1) {
      minimumIntegerPartSize = 1;
    }
    if (minimumIntegerPartSize === 0 && minimumFactionalPartSize === 0) {
      minimumFactionalPartSize = 1;
    }
    let minimumExponentSize = 0;
    if (exponentPresent) {
      minimumExponentSize = parts.exponentPart.split('').filter((char) => decimalDigitFamily.indexOf(char) !== -1).length;
    }

    return {
      integerPartGroupingPositions,
      regularGrouping,
      minimumIntegerPartSize,
      scalingFactor,
      prefix: parts.prefix,
      fractionalPartGroupingPositions,
      minimumFactionalPartSize,
      maximumFactionalPartSize,
      minimumExponentSize,
      suffix: parts.suffix,
      picture: parts.subpicture,
    };
  };

  const parts = subPictures.map(splitParts);
  parts.forEach(validate);

  const variables = parts.map(analyse);

  if (variables.length === 1) {
    variables.push(JSON.parse(JSON.stringify(variables[0])));
    variables[1].prefix = properties['minus-sign'] + variables[1].prefix;
  }

  return { properties, decimalDigitFamily, variables };
}

/** The value-dependent half of `$formatNumber` (XPath F&O bullets 2-14). */
function formatWithPicture(value, properties, decimalDigitFamily, variables,
  minus_sign, zero_digit, decimal_separator, grouping_separator) {
  // format the number
  // bullet 2:
  let pic;
  if (value >= 0) {
    pic = variables[0];
  } else {
    pic = variables[1];
  }
  // bullet 3:
  let adjustedNumber;
  if (pic.picture.indexOf(properties.percent) !== -1) {
    adjustedNumber = value * 100;
  } else if (pic.picture.indexOf(properties['per-mille']) !== -1) {
    adjustedNumber = value * 1000;
  } else {
    adjustedNumber = value;
  }
  // bullet 5:
  let mantissa, exponent;
  if (pic.minimumExponentSize === 0) {
    mantissa = adjustedNumber;
  } else {
    // mantissa * 10^exponent = adjustedNumber
    const maxMantissa = Math.pow(10, pic.scalingFactor);
    const minMantissa = Math.pow(10, pic.scalingFactor - 1);
    mantissa = adjustedNumber;
    exponent = 0;
    // For zero the desired exponent is simply zero (XPath F&O Bullet 5: "if
    // N is zero, set M to zero and E to zero") — guards against an infinite
    // loop for zero/negative mantissas.
    if (mantissa !== 0) {
      while (Math.abs(mantissa) < minMantissa) {
        mantissa *= 10;
        exponent -= 1;
      }
      while (Math.abs(mantissa) > maxMantissa) {
        mantissa /= 10;
        exponent += 1;
      }
    }
  }
  // bullet 6:
  const roundedNumber = fn_round(mantissa, pic.maximumFactionalPartSize);
  // bullet 7:
  const makeString = function (val, dp) {
    let str = Math.abs(val).toFixed(dp);
    if (zero_digit !== '0') {
      str = str
        .split('')
        .map((digit) => (digit >= '0' && digit <= '9' ? decimalDigitFamily[digit.charCodeAt(0) - 48] : digit))
        .join('');
    }
    return str;
  };
  let stringValue = makeString(roundedNumber, pic.maximumFactionalPartSize);
  let decimalPos = stringValue.indexOf('.');
  if (decimalPos === -1) {
    stringValue = stringValue + decimal_separator;
  } else {
    stringValue = stringValue.replace('.', decimal_separator);
  }
  while (stringValue.charAt(0) === zero_digit) {
    stringValue = stringValue.substring(1);
  }
  while (stringValue.charAt(stringValue.length - 1) === zero_digit) {
    stringValue = stringValue.substring(0, stringValue.length - 1);
  }
  // bullets 8 & 9:
  decimalPos = stringValue.indexOf(decimal_separator);
  const padLeft = pic.minimumIntegerPartSize - decimalPos;
  const padRight = pic.minimumFactionalPartSize - (stringValue.length - decimalPos - 1);
  stringValue = (padLeft > 0 ? new Array(padLeft + 1).join(zero_digit) : '') + stringValue;
  stringValue = stringValue + (padRight > 0 ? new Array(padRight + 1).join(zero_digit) : '');
  decimalPos = stringValue.indexOf(decimal_separator);
  // bullet 10:
  if (pic.regularGrouping > 0) {
    const groupCount = Math.floor((decimalPos - 1) / pic.regularGrouping);
    for (let group = 1; group <= groupCount; group++) {
      stringValue = [
        stringValue.slice(0, decimalPos - group * pic.regularGrouping),
        grouping_separator,
        stringValue.slice(decimalPos - group * pic.regularGrouping),
      ].join('');
    }
  } else {
    pic.integerPartGroupingPositions.forEach((pos) => {
      stringValue = [stringValue.slice(0, decimalPos - pos), grouping_separator, stringValue.slice(decimalPos - pos)].join('');
      decimalPos++;
    });
  }
  // bullet 11:
  decimalPos = stringValue.indexOf(decimal_separator);
  pic.fractionalPartGroupingPositions.forEach((pos) => {
    stringValue = [stringValue.slice(0, pos + decimalPos + 1), grouping_separator, stringValue.slice(pos + decimalPos + 1)].join('');
  });
  // bullet 12:
  decimalPos = stringValue.indexOf(decimal_separator);
  if (pic.picture.indexOf(decimal_separator) === -1 || decimalPos === stringValue.length - 1) {
    stringValue = stringValue.substring(0, stringValue.length - 1);
  }
  // bullet 13:
  if (typeof exponent !== 'undefined') {
    let stringExponent = makeString(exponent, 0);
    const expPadLeft = pic.minimumExponentSize - stringExponent.length;
    if (expPadLeft > 0) {
      stringExponent = new Array(expPadLeft + 1).join(zero_digit) + stringExponent;
    }
    stringValue = stringValue + properties['exponent-separator'] + (exponent < 0 ? minus_sign : '') + stringExponent;
  }
  // bullet 14:
  stringValue = pic.prefix + stringValue + pic.suffix;
  return stringValue;
}

/** `$formatBase(value[, radix])` — radix must be in [2, 36] (default 10); D3100 otherwise. */
function fn_formatBase(value, radix) {
  if (value === undefined) return undefined;

  value = fn_round(value);

  if (radix === undefined) {
    radix = 10;
  } else {
    radix = fn_round(radix);
  }

  if (radix < 2 || radix > 36) {
    throw err('D3100', { value: radix });
  }

  return value.toString(radix);
}

module.exports = {
  fn_number,
  fn_abs,
  fn_floor,
  fn_ceil,
  fn_round,
  fn_sqrt,
  fn_power,
  fn_random,
  fn_formatNumber,
  fn_formatBase,
};
