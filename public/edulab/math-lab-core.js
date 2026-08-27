(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MathLabCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const functions = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    sqrt: Math.sqrt,
    abs: Math.abs,
    ln: Math.log,
    log: Math.log10,
    exp: Math.exp
  };

  function tokenize(source) {
    const text = String(source || '')
      .replace(/[−–—]/g, '-')
      .replace(/π/g, 'pi')
      .replace(/\s+/g, '');
    if (!text) throw new Error('请输入函数表达式');

    const tokens = [];
    let index = 0;
    while (index < text.length) {
      const rest = text.slice(index);
      const number = rest.match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
      if (number) {
        tokens.push({ type: 'number', value: Number(number[0]) });
        index += number[0].length;
        continue;
      }

      const name = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (name) {
        tokens.push({ type: 'name', value: name[0].toLowerCase() });
        index += name[0].length;
        continue;
      }

      const character = text[index];
      if ('+-*/^()'.includes(character)) {
        tokens.push({ type: character, value: character });
        index += 1;
        continue;
      }
      throw new Error('无法识别字符“' + character + '”');
    }
    tokens.push({ type: 'eof', value: '' });
    return tokens;
  }

  function compileExpression(source) {
    const tokens = tokenize(source);
    let cursor = 0;
    const peek = () => tokens[cursor];
    const take = type => {
      const token = peek();
      if (token.type !== type) throw new Error('表达式格式不完整');
      cursor += 1;
      return token;
    };

    function primary() {
      const token = peek();
      if (token.type === 'number') {
        cursor += 1;
        return () => token.value;
      }
      if (token.type === '(') {
        cursor += 1;
        const inner = addSubtract();
        take(')');
        return inner;
      }
      if (token.type === 'name') {
        cursor += 1;
        const name = token.value;
        if (name === 'x' || name === 'a') return scope => Number(scope[name]);
        if (name === 'pi') return () => Math.PI;
        if (name === 'e') return () => Math.E;
        if (!functions[name]) throw new Error('不支持函数“' + name + '”');
        take('(');
        const argument = addSubtract();
        take(')');
        return scope => functions[name](argument(scope));
      }
      throw new Error('表达式格式不完整');
    }

    function power() {
      let left = primary();
      if (peek().type === '^') {
        cursor += 1;
        const right = unary();
        const previous = left;
        left = scope => Math.pow(previous(scope), right(scope));
      }
      return left;
    }

    function unary() {
      if (peek().type === '+') {
        cursor += 1;
        return unary();
      }
      if (peek().type === '-') {
        cursor += 1;
        const value = unary();
        return scope => -value(scope);
      }
      return power();
    }

    function multiplyDivide() {
      let left = unary();
      while (peek().type === '*' || peek().type === '/') {
        const operator = peek().type;
        cursor += 1;
        const right = unary();
        const previous = left;
        left = operator === '*'
          ? scope => previous(scope) * right(scope)
          : scope => previous(scope) / right(scope);
      }
      return left;
    }

    function addSubtract() {
      let left = multiplyDivide();
      while (peek().type === '+' || peek().type === '-') {
        const operator = peek().type;
        cursor += 1;
        const right = multiplyDivide();
        const previous = left;
        left = operator === '+'
          ? scope => previous(scope) + right(scope)
          : scope => previous(scope) - right(scope);
      }
      return left;
    }

    const expression = addSubtract();
    if (peek().type !== 'eof') throw new Error('表达式中存在多余内容');
    return scope => expression({ x: Number(scope.x), a: Number(scope.a) });
  }

  function sampleExpression(expression, parameterA, minX, maxX, sampleCount) {
    const evaluator = compileExpression(expression);
    const count = Math.max(2, Number(sampleCount) || 2);
    const start = Number(minX);
    const end = Number(maxX);
    const step = (end - start) / (count - 1);
    return Array.from({ length: count }, (_, index) => {
      const x = start + index * step;
      let y = evaluator({ x, a: Number(parameterA) });
      if (!Number.isFinite(y) || Math.abs(y) > 1e6) y = null;
      return { x, y };
    });
  }

  function formatNumber(value) {
    const number = Object.is(value, -0) ? 0 : Number(value);
    if (!Number.isFinite(number)) return '—';
    const rounded = Math.round(number * 100) / 100;
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }

  return { compileExpression, sampleExpression, formatNumber };
});
