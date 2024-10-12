// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = (value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
};
var resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then((res) => Promise.all(res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))).then(() => buffer[0]));
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
};

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setHeaders = (headers, map = {}) => {
  Object.entries(map).forEach(([key, value]) => headers.set(key, value));
  return headers;
};
var Context = class {
  req;
  env = {};
  _var = {};
  finalized = false;
  error = undefined;
  #status = 200;
  #executionCtx;
  #headers = undefined;
  #preparedHeaders = undefined;
  #res;
  #isFresh = true;
  layout = undefined;
  renderer = (content) => this.html(content);
  notFoundHandler = () => new Response;
  constructor(req, options) {
    this.req = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      if (options.notFoundHandler) {
        this.notFoundHandler = options.notFoundHandler;
      }
    }
  }
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  get res() {
    this.#isFresh = false;
    return this.#res ||= new Response("404 Not Found", { status: 404 });
  }
  set res(_res) {
    this.#isFresh = false;
    if (this.#res && _res) {
      this.#res.headers.delete("content-type");
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  render = (...args) => this.renderer(...args);
  setLayout = (layout) => this.layout = layout;
  getLayout = () => this.layout;
  setRenderer = (renderer) => {
    this.renderer = renderer;
  };
  header = (name, value, options) => {
    if (value === undefined) {
      if (this.#headers) {
        this.#headers.delete(name);
      } else if (this.#preparedHeaders) {
        delete this.#preparedHeaders[name.toLocaleLowerCase()];
      }
      if (this.finalized) {
        this.res.headers.delete(name);
      }
      return;
    }
    if (options?.append) {
      if (!this.#headers) {
        this.#isFresh = false;
        this.#headers = new Headers(this.#preparedHeaders);
        this.#preparedHeaders = {};
      }
      this.#headers.append(name, value);
    } else {
      if (this.#headers) {
        this.#headers.set(name, value);
      } else {
        this.#preparedHeaders ??= {};
        this.#preparedHeaders[name.toLowerCase()] = value;
      }
    }
    if (this.finalized) {
      if (options?.append) {
        this.res.headers.append(name, value);
      } else {
        this.res.headers.set(name, value);
      }
    }
  };
  status = (status) => {
    this.#isFresh = false;
    this.#status = status;
  };
  set = (key, value) => {
    this._var ??= {};
    this._var[key] = value;
  };
  get = (key) => {
    return this._var ? this._var[key] : undefined;
  };
  get var() {
    return { ...this._var };
  }
  newResponse = (data, arg, headers) => {
    if (this.#isFresh && !headers && !arg && this.#status === 200) {
      return new Response(data, {
        headers: this.#preparedHeaders
      });
    }
    if (arg && typeof arg !== "number") {
      const header = new Headers(arg.headers);
      if (this.#headers) {
        this.#headers.forEach((v, k) => {
          if (k === "set-cookie") {
            header.append(k, v);
          } else {
            header.set(k, v);
          }
        });
      }
      const headers2 = setHeaders(header, this.#preparedHeaders);
      return new Response(data, {
        headers: headers2,
        status: arg.status ?? this.#status
      });
    }
    const status = typeof arg === "number" ? arg : this.#status;
    this.#preparedHeaders ??= {};
    this.#headers ??= new Headers;
    setHeaders(this.#headers, this.#preparedHeaders);
    if (this.#res) {
      this.#res.headers.forEach((v, k) => {
        if (k === "set-cookie") {
          this.#headers?.append(k, v);
        } else {
          this.#headers?.set(k, v);
        }
      });
      setHeaders(this.#headers, this.#preparedHeaders);
    }
    headers ??= {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string") {
        this.#headers.set(k, v);
      } else {
        this.#headers.delete(k);
        for (const v2 of v) {
          this.#headers.append(k, v2);
        }
      }
    }
    return new Response(data, {
      status,
      headers: this.#headers
    });
  };
  body = (data, arg, headers) => {
    return typeof arg === "number" ? this.newResponse(data, arg, headers) : this.newResponse(data, arg);
  };
  text = (text, arg, headers) => {
    if (!this.#preparedHeaders) {
      if (this.#isFresh && !headers && !arg) {
        return new Response(text);
      }
      this.#preparedHeaders = {};
    }
    this.#preparedHeaders["content-type"] = TEXT_PLAIN;
    return typeof arg === "number" ? this.newResponse(text, arg, headers) : this.newResponse(text, arg);
  };
  json = (object, arg, headers) => {
    const body = JSON.stringify(object);
    this.#preparedHeaders ??= {};
    this.#preparedHeaders["content-type"] = "application/json; charset=UTF-8";
    return typeof arg === "number" ? this.newResponse(body, arg, headers) : this.newResponse(body, arg);
  };
  html = (html2, arg, headers) => {
    this.#preparedHeaders ??= {};
    this.#preparedHeaders["content-type"] = "text/html; charset=UTF-8";
    if (typeof html2 === "object") {
      if (!(html2 instanceof Promise)) {
        html2 = html2.toString();
      }
      if (html2 instanceof Promise) {
        return html2.then((html22) => resolveCallback(html22, HtmlEscapedCallbackPhase.Stringify, false, {})).then((html22) => {
          return typeof arg === "number" ? this.newResponse(html22, arg, headers) : this.newResponse(html22, arg);
        });
      }
    }
    return typeof arg === "number" ? this.newResponse(html2, arg, headers) : this.newResponse(html2, arg);
  };
  redirect = (location, status = 302) => {
    this.#headers ??= new Headers;
    this.#headers.set("Location", location);
    return this.newResponse(null, status);
  };
  notFound = () => {
    return this.notFoundHandler(this);
  };
};

// node_modules/hono/dist/compose.js
var compose = (middleware, onError, onNotFound) => {
  return (context2, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        if (context2 instanceof Context) {
          context2.req.routeIndex = i;
        }
      } else {
        handler = i === middleware.length && next || undefined;
      }
      if (!handler) {
        if (context2 instanceof Context && context2.finalized === false && onNotFound) {
          res = await onNotFound(context2);
        }
      } else {
        try {
          res = await handler(context2, () => {
            return dispatch(i + 1);
          });
        } catch (err) {
          if (err instanceof Error && context2 instanceof Context && onError) {
            context2.error = err;
            res = await onError(err, context2);
            isError = true;
          } else {
            throw err;
          }
        }
      }
      if (res && (context2.finalized === false || isError)) {
        context2.res = res;
      }
      return context2;
    }
  };
};

// node_modules/hono/dist/http-exception.js
var HTTPException = class extends Error {
  res;
  status;
  constructor(status = 500, options) {
    super(options?.message, { cause: options?.cause });
    this.res = options?.res;
    this.status = status;
  }
  getResponse() {
    if (this.res) {
      const newResponse = new Response(this.res.body, {
        status: this.status,
        headers: this.res.headers
      });
      return newResponse;
    }
    return new Response(this.message, {
      status: this.status
    });
  }
};

// node_modules/hono/dist/utils/body.js
async function parseFormData(request2, options) {
  const formData = await request2.formData();
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
var convertFormDataToBodyData = function(formData, options) {
  const form = Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
};
var parseBody = async (request2, options = Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = request2 instanceof HonoRequest ? request2.raw.headers : request2.headers;
  const contentType = headers.get("Content-Type");
  if (contentType !== null && contentType.startsWith("multipart/form-data") || contentType !== null && contentType.startsWith("application/x-www-form-urlencoded")) {
    return parseFormData(request2, { all, dot });
  }
  return {};
};
var handleParsingAllValues = (form, key, value) => {
  if (form[key] !== undefined) {
    if (Array.isArray(form[key])) {
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    form[key] = value;
  }
};
var handleParsingNestedValues = (form, key, value) => {
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
};

// node_modules/hono/dist/utils/url.js
var splitPath = (path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
};
var splitRoutingPath = (routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
};
var extractGroupsFromPath = (path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match, index) => {
    const mark = `@${index}`;
    groups.push([mark, match]);
    return mark;
  });
  return { groups, path };
};
var replaceGroupMarks = (paths, groups) => {
  for (let i = groups.length - 1;i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1;j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
};
var patternCache = {};
var getPattern = (label) => {
  if (label === "*") {
    return "*";
  }
  const match = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match) {
    if (!patternCache[label]) {
      if (match[2]) {
        patternCache[label] = [label, match[1], new RegExp("^" + match[2] + "$")];
      } else {
        patternCache[label] = [label, match[1], true];
      }
    }
    return patternCache[label];
  }
  return null;
};
var tryDecodeURI = (str) => {
  try {
    return decodeURI(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decodeURI(match);
      } catch {
        return match;
      }
    });
  }
};
var getPath = (request2) => {
  const url = request2.url;
  const start = url.indexOf("/", 8);
  let i = start;
  for (;i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const path = url.slice(start, queryIndex === -1 ? undefined : queryIndex);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63) {
      break;
    }
  }
  return url.slice(start, i);
};
var getPathNoStrict = (request2) => {
  const result = getPath(request2);
  return result.length > 1 && result[result.length - 1] === "/" ? result.slice(0, -1) : result;
};
var mergePath = (...paths) => {
  let p = "";
  let endsWithSlash = false;
  for (let path of paths) {
    if (p[p.length - 1] === "/") {
      p = p.slice(0, -1);
      endsWithSlash = true;
    }
    if (path[0] !== "/") {
      path = `/${path}`;
    }
    if (path === "/" && endsWithSlash) {
      p = `${p}/`;
    } else if (path !== "/") {
      p = `${p}${path}`;
    }
    if (path === "/" && p === "") {
      p = "/";
    }
  }
  return p;
};
var checkOptionalParameter = (path) => {
  if (!path.match(/\:.+\?$/)) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace("?", "");
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
};
var _decodeURI = (value) => {
  if (!/[%+]/.test(value)) {
    return value;
  }
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return /%/.test(value) ? decodeURIComponent_(value) : value;
};
var _getQueryParam = (url, key, multiple) => {
  let encoded;
  if (!multiple && key && !/[%+]/.test(key)) {
    let keyIndex2 = url.indexOf(`?${key}`, 8);
    if (keyIndex2 === -1) {
      keyIndex2 = url.indexOf(`&${key}`, 8);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? undefined : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return;
    }
  }
  const results = {};
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? undefined : nextKeyIndex : valueIndex);
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? undefined : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
};
var getQueryParam = _getQueryParam;
var getQueryParams = (url, key) => {
  return _getQueryParam(url, key, true);
};
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var HonoRequest = class {
  raw;
  #validatedData;
  #matchResult;
  routeIndex = 0;
  path;
  bodyCache = {};
  constructor(request2, path = "/", matchResult = [[]]) {
    this.raw = request2;
    this.path = path;
    this.#matchResult = matchResult;
    this.#validatedData = {};
  }
  param(key) {
    return key ? this.getDecodedParam(key) : this.getAllDecodedParams();
  }
  getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.getParamValue(paramKey);
    return param ? /\%/.test(param) ? decodeURIComponent_(param) : param : undefined;
  }
  getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys) {
      const value = this.getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value && typeof value === "string") {
        decoded[key] = /\%/.test(value) ? decodeURIComponent_(value) : value;
      }
    }
    return decoded;
  }
  getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name.toLowerCase()) ?? undefined;
    }
    const headerData = {};
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    if (this.bodyCache.parsedBody) {
      return this.bodyCache.parsedBody;
    }
    const parsedBody = await parseBody(this, options);
    this.bodyCache.parsedBody = parsedBody;
    return parsedBody;
  }
  cachedBody = (key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    if (!bodyCache[key]) {
      for (const keyOfBodyCache of Object.keys(bodyCache)) {
        if (keyOfBodyCache === "parsedBody") {
          continue;
        }
        return (async () => {
          let body2 = await bodyCache[keyOfBodyCache];
          if (keyOfBodyCache === "json") {
            body2 = JSON.stringify(body2);
          }
          return await new Response(body2)[key]();
        })();
      }
    }
    return bodyCache[key] = raw2[key]();
  };
  json() {
    return this.cachedBody("json");
  }
  text() {
    return this.cachedBody("text");
  }
  arrayBuffer() {
    return this.cachedBody("arrayBuffer");
  }
  blob() {
    return this.cachedBody("blob");
  }
  formData() {
    return this.cachedBody("formData");
  }
  addValidatedData(target, data) {
    this.#validatedData[target] = data;
  }
  valid(target) {
    return this.#validatedData[target];
  }
  get url() {
    return this.raw.url;
  }
  get method() {
    return this.raw.method;
  }
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
};

// node_modules/hono/dist/hono-base.js
var COMPOSED_HANDLER = Symbol("composedHandler");
var notFoundHandler = (c) => {
  return c.text("404 Not Found", 404);
};
var errorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
};
var Hono = class {
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  router;
  getPath;
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          if (typeof handler !== "string") {
            this.addRoute(method, this.#path, handler);
          }
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      if (!method) {
        return this;
      }
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const strict = options.strict ?? true;
    delete options.strict;
    Object.assign(this, options);
    this.getPath = strict ? options.getPath ?? getPath : getPathNoStrict;
  }
  clone() {
    const clone = new Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.routes = this.routes;
    return clone;
  }
  notFoundHandler = notFoundHandler;
  errorHandler = errorHandler;
  route(path, app) {
    const subApp = this.basePath(path);
    if (!app) {
      return subApp;
    }
    app.routes.map((r) => {
      let handler;
      if (app.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res;
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.addRoute(r.method, r.path, handler);
    });
    return this;
  }
  basePath(path) {
    const subApp = this.clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  notFound = (handler) => {
    this.notFoundHandler = handler;
    return this;
  };
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        replaceRequest = options.replaceRequest;
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = undefined;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request3) => {
        const url3 = new URL(request3.url);
        url3.pathname = url3.pathname.slice(pathPrefixLength) || "/";
        return new Request(url3, request3);
      };
    })();
    const handler = async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    };
    this.addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  addRoute(method, path, handler) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = { path, method, handler };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  matchRoute(method, path) {
    return this.router.match(method, path);
  }
  handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  dispatch(request3, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.dispatch(request3, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request3, { env });
    const matchResult = this.matchRoute(method, path);
    const c = new Context(new HonoRequest(request3, path, matchResult), {
      env,
      executionCtx,
      notFoundHandler: this.notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.notFoundHandler(c);
        });
      } catch (err) {
        return this.handleError(err, c);
      }
      return res instanceof Promise ? res.then((resolved) => resolved || (c.finalized ? c.res : this.notFoundHandler(c))).catch((err) => this.handleError(err, c)) : res;
    }
    const composed = compose(matchResult[0], this.errorHandler, this.notFoundHandler);
    return (async () => {
      try {
        const context3 = await composed(c);
        if (!context3.finalized) {
          throw new Error("Context is not finalized. You may forget returning Response object or `await next()`");
        }
        return context3.res;
      } catch (err) {
        return this.handleError(err, c);
      }
    })();
  }
  fetch = (request3, ...rest) => {
    return this.dispatch(request3, rest[1], rest[0], request3.method);
  };
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      if (requestInit !== undefined) {
        input = new Request(input, requestInit);
      }
      return this.fetch(input, Env, executionCtx);
    }
    input = input.toString();
    const path = /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`;
    const req = new Request(path, requestInit);
    return this.fetch(req, Env, executionCtx);
  };
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.dispatch(event.request, event, undefined, event.request.method));
    });
  };
};

// node_modules/hono/dist/router/reg-exp-router/node.js
var compareKey = function(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
};
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
var Node = class {
  index;
  varIndex;
  children = Object.create(null);
  insert(tokens, index, paramMap, context3, pathErrorCheckOnly) {
    if (tokens.length === 0) {
      if (this.index !== undefined) {
        throw PATH_ERROR;
      }
      if (pathErrorCheckOnly) {
        return;
      }
      this.index = index;
      return;
    }
    const [token, ...restTokens] = tokens;
    const pattern = token === "*" ? restTokens.length === 0 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
    let node;
    if (pattern) {
      const name = pattern[1];
      let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
      if (name && pattern[2]) {
        regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
        if (/\((?!\?:)/.test(regexpStr)) {
          throw PATH_ERROR;
        }
      }
      node = this.children[regexpStr];
      if (!node) {
        if (Object.keys(this.children).some((k) => k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR)) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.children[regexpStr] = new Node;
        if (name !== "") {
          node.varIndex = context3.varIndex++;
        }
      }
      if (!pathErrorCheckOnly && name !== "") {
        paramMap.push([name, node.varIndex]);
      }
    } else {
      node = this.children[token];
      if (!node) {
        if (Object.keys(this.children).some((k) => k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR)) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.children[token] = new Node;
      }
    }
    node.insert(restTokens, index, paramMap, context3, pathErrorCheckOnly);
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.children[k];
      return (typeof c.varIndex === "number" ? `(${k})@${c.varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + c.buildRegExpStr();
    });
    if (typeof this.index === "number") {
      strList.unshift(`#${this.index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
};

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  context = { varIndex: 0 };
  root = new Node;
  insert(path, index, pathErrorCheckOnly) {
    const paramAssoc = [];
    const groups = [];
    for (let i = 0;; ) {
      let replaced = false;
      path = path.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = path.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1;i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1;j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.root.insert(tokens, index, paramAssoc, this.context, pathErrorCheckOnly);
    return paramAssoc;
  }
  buildRegExp() {
    let regexp = this.root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (typeof handlerIndex !== "undefined") {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (typeof paramIndex !== "undefined") {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
};

// node_modules/hono/dist/router/reg-exp-router/router.js
var buildWildcardRegExp = function(path) {
  return wildcardRegExpCache[path] ??= new RegExp(path === "*" ? "" : `^${path.replace(/\/\*$|([.\\+*[^\]$()])/g, (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)")}\$`);
};
var clearWildcardRegExpCache = function() {
  wildcardRegExpCache = Object.create(null);
};
var buildMatcherFromPreprocessedRoutes = function(routes) {
  const trie2 = new Trie;
  const handlerData = [];
  if (routes.length === 0) {
    return nullMatcher;
  }
  const routesWithStaticPathFlag = routes.map((route) => [!/\*|\/:/.test(route[0]), ...route]).sort(([isStaticA, pathA], [isStaticB, pathB]) => isStaticA ? 1 : isStaticB ? -1 : pathA.length - pathB.length);
  const staticMap = Object.create(null);
  for (let i = 0, j = -1, len = routesWithStaticPathFlag.length;i < len; i++) {
    const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i];
    if (pathErrorCheckOnly) {
      staticMap[path] = [handlers.map(([h]) => [h, Object.create(null)]), emptyParam];
    } else {
      j++;
    }
    let paramAssoc;
    try {
      paramAssoc = trie2.insert(path, j, pathErrorCheckOnly);
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
    if (pathErrorCheckOnly) {
      continue;
    }
    handlerData[j] = handlers.map(([h, paramCount]) => {
      const paramIndexMap = Object.create(null);
      paramCount -= 1;
      for (;paramCount >= 0; paramCount--) {
        const [key, value] = paramAssoc[paramCount];
        paramIndexMap[key] = value;
      }
      return [h, paramIndexMap];
    });
  }
  const [regexp, indexReplacementMap, paramReplacementMap] = trie2.buildRegExp();
  for (let i = 0, len = handlerData.length;i < len; i++) {
    for (let j = 0, len2 = handlerData[i].length;j < len2; j++) {
      const map = handlerData[i][j]?.[1];
      if (!map) {
        continue;
      }
      const keys = Object.keys(map);
      for (let k = 0, len3 = keys.length;k < len3; k++) {
        map[keys[k]] = paramReplacementMap[map[keys[k]]];
      }
    }
  }
  const handlerMap = [];
  for (const i in indexReplacementMap) {
    handlerMap[i] = handlerData[indexReplacementMap[i]];
  }
  return [regexp, handlerMap, staticMap];
};
var findMiddleware = function(middleware, path) {
  if (!middleware) {
    return;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return;
};
var emptyParam = [];
var nullMatcher = [/^$/, [], Object.create(null)];
var wildcardRegExpCache = Object.create(null);
var RegExpRouter = class {
  name = "RegExpRouter";
  middleware;
  routes;
  constructor() {
    this.middleware = { [METHOD_NAME_ALL]: Object.create(null) };
    this.routes = { [METHOD_NAME_ALL]: Object.create(null) };
  }
  add(method, path, handler) {
    const { middleware, routes } = this;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      if (method === METHOD_NAME_ALL) {
        Object.keys(middleware).forEach((m) => {
          middleware[m][path] ||= findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        });
      } else {
        middleware[method][path] ||= findMiddleware(middleware[method], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
      }
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach((p) => re.test(p) && routes[m][p].push([handler, paramCount]));
        }
      });
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths.length;i < len; i++) {
      const path2 = paths[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          routes[m][path2] ||= [
            ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
          ];
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match(method, path) {
    clearWildcardRegExpCache();
    const matchers = this.buildAllMatchers();
    this.match = (method2, path2) => {
      const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
      const staticMatch = matcher[2][path2];
      if (staticMatch) {
        return staticMatch;
      }
      const match = path2.match(matcher[0]);
      if (!match) {
        return [[], emptyParam];
      }
      const index = match.indexOf("", 1);
      return [matcher[1][index], match];
    };
    return this.match(method, path);
  }
  buildAllMatchers() {
    const matchers = Object.create(null);
    [...Object.keys(this.routes), ...Object.keys(this.middleware)].forEach((method) => {
      matchers[method] ||= this.buildMatcher(method);
    });
    this.middleware = this.routes = undefined;
    return matchers;
  }
  buildMatcher(method) {
    const routes = [];
    let hasOwnRoute = method === METHOD_NAME_ALL;
    [this.middleware, this.routes].forEach((r) => {
      const ownRoute = r[method] ? Object.keys(r[method]).map((path) => [path, r[method][path]]) : [];
      if (ownRoute.length !== 0) {
        hasOwnRoute ||= true;
        routes.push(...ownRoute);
      } else if (method !== METHOD_NAME_ALL) {
        routes.push(...Object.keys(r[METHOD_NAME_ALL]).map((path) => [path, r[METHOD_NAME_ALL][path]]));
      }
    });
    if (!hasOwnRoute) {
      return null;
    } else {
      return buildMatcherFromPreprocessedRoutes(routes);
    }
  }
};

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  name = "SmartRouter";
  routers = [];
  routes = [];
  constructor(init) {
    Object.assign(this, init);
  }
  add(method, path, handler) {
    if (!this.routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.routes) {
      throw new Error("Fatal error");
    }
    const { routers, routes } = this;
    const len = routers.length;
    let i = 0;
    let res;
    for (;i < len; i++) {
      const router5 = routers[i];
      try {
        routes.forEach((args) => {
          router5.add(...args);
        });
        res = router5.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router5.match.bind(router5);
      this.routers = [router5];
      this.routes = undefined;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.routes || this.routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.routers[0];
  }
};

// node_modules/hono/dist/router/trie-router/node.js
var Node2 = class {
  methods;
  children;
  patterns;
  order = 0;
  name;
  params = Object.create(null);
  constructor(method, handler, children) {
    this.children = children || Object.create(null);
    this.methods = [];
    this.name = "";
    if (method && handler) {
      const m = Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0, name: this.name };
      this.methods = [m];
    }
    this.patterns = [];
  }
  insert(method, path, handler) {
    this.name = `${method} ${path}`;
    this.order = ++this.order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length;i < len; i++) {
      const p = parts[i];
      if (Object.keys(curNode.children).includes(p)) {
        curNode = curNode.children[p];
        const pattern2 = getPattern(p);
        if (pattern2) {
          possibleKeys.push(pattern2[1]);
        }
        continue;
      }
      curNode.children[p] = new Node2;
      const pattern = getPattern(p);
      if (pattern) {
        curNode.patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.children[p];
    }
    if (!curNode.methods.length) {
      curNode.methods = [];
    }
    const m = Object.create(null);
    const handlerSet = {
      handler,
      possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
      name: this.name,
      score: this.order
    };
    m[method] = handlerSet;
    curNode.methods.push(m);
    return curNode;
  }
  gHSets(node3, method, nodeParams, params) {
    const handlerSets = [];
    for (let i = 0, len = node3.methods.length;i < len; i++) {
      const m = node3.methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = Object.create(null);
      if (handlerSet !== undefined) {
        handlerSet.params = Object.create(null);
        handlerSet.possibleKeys.forEach((key) => {
          const processed = processedSet[handlerSet.name];
          handlerSet.params[key] = params[key] && !processed ? params[key] : nodeParams[key] ?? params[key];
          processedSet[handlerSet.name] = true;
        });
        handlerSets.push(handlerSet);
      }
    }
    return handlerSets;
  }
  search(method, path) {
    const handlerSets = [];
    this.params = Object.create(null);
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    for (let i = 0, len = parts.length;i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length;j < len2; j++) {
        const node3 = curNodes[j];
        const nextNode = node3.children[part];
        if (nextNode) {
          nextNode.params = node3.params;
          if (isLast === true) {
            if (nextNode.children["*"]) {
              handlerSets.push(...this.gHSets(nextNode.children["*"], method, node3.params, Object.create(null)));
            }
            handlerSets.push(...this.gHSets(nextNode, method, node3.params, Object.create(null)));
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node3.patterns.length;k < len3; k++) {
          const pattern = node3.patterns[k];
          const params = { ...node3.params };
          if (pattern === "*") {
            const astNode = node3.children["*"];
            if (astNode) {
              handlerSets.push(...this.gHSets(astNode, method, node3.params, Object.create(null)));
              tempNodes.push(astNode);
            }
            continue;
          }
          if (part === "") {
            continue;
          }
          const [key, name, matcher] = pattern;
          const child = node3.children[key];
          const restPathString = parts.slice(i).join("/");
          if (matcher instanceof RegExp && matcher.test(restPathString)) {
            params[name] = restPathString;
            handlerSets.push(...this.gHSets(child, method, node3.params, params));
            continue;
          }
          if (matcher === true || matcher instanceof RegExp && matcher.test(part)) {
            if (typeof key === "string") {
              params[name] = part;
              if (isLast === true) {
                handlerSets.push(...this.gHSets(child, method, params, node3.params));
                if (child.children["*"]) {
                  handlerSets.push(...this.gHSets(child.children["*"], method, params, node3.params));
                }
              } else {
                child.params = params;
                tempNodes.push(child);
              }
            }
          }
        }
      }
      curNodes = tempNodes;
    }
    const results = handlerSets.sort((a, b) => {
      return a.score - b.score;
    });
    return [results.map(({ handler, params }) => [handler, params])];
  }
};

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  name = "TrieRouter";
  node;
  constructor() {
    this.node = new Node2;
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (const p of results) {
        this.node.insert(method, p, handler);
      }
      return;
    }
    this.node.insert(method, path, handler);
  }
  match(method, path) {
    return this.node.search(method, path);
  }
};

// node_modules/hono/dist/hono.js
var Hono2 = class extends Hono {
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter, new TrieRouter]
    });
  }
};

// node_modules/hono/dist/middleware/cors/index.js
var cors = (options) => {
  const defaults = {
    origin: "*",
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
    allowHeaders: [],
    exposeHeaders: []
  };
  const opts = {
    ...defaults,
    ...options
  };
  const findAllowOrigin = ((optsOrigin) => {
    if (typeof optsOrigin === "string") {
      return () => optsOrigin;
    } else if (typeof optsOrigin === "function") {
      return optsOrigin;
    } else {
      return (origin) => optsOrigin.includes(origin) ? origin : optsOrigin[0];
    }
  })(opts.origin);
  return async function cors2(c, next) {
    function set(key, value) {
      c.res.headers.set(key, value);
    }
    const allowOrigin = findAllowOrigin(c.req.header("origin") || "", c);
    if (allowOrigin) {
      set("Access-Control-Allow-Origin", allowOrigin);
    }
    if (opts.origin !== "*") {
      set("Vary", "Origin");
    }
    if (opts.credentials) {
      set("Access-Control-Allow-Credentials", "true");
    }
    if (opts.exposeHeaders?.length) {
      set("Access-Control-Expose-Headers", opts.exposeHeaders.join(","));
    }
    if (c.req.method === "OPTIONS") {
      if (opts.maxAge != null) {
        set("Access-Control-Max-Age", opts.maxAge.toString());
      }
      if (opts.allowMethods?.length) {
        set("Access-Control-Allow-Methods", opts.allowMethods.join(","));
      }
      let headers = opts.allowHeaders;
      if (!headers?.length) {
        const requestHeaders = c.req.header("Access-Control-Request-Headers");
        if (requestHeaders) {
          headers = requestHeaders.split(/\s*,\s*/);
        }
      }
      if (headers?.length) {
        set("Access-Control-Allow-Headers", headers.join(","));
        c.res.headers.append("Vary", "Access-Control-Request-Headers");
      }
      c.res.headers.delete("Content-Length");
      c.res.headers.delete("Content-Type");
      return new Response(null, {
        headers: c.res.headers,
        status: 204,
        statusText: c.res.statusText
      });
    }
    await next();
  };
};

// node_modules/@xata.io/client/dist/index.mjs
var getLens = function(b64) {
  const len = b64.length;
  if (len % 4 > 0) {
    throw new Error("Invalid string. Length must be a multiple of 4");
  }
  let validLen = b64.indexOf("=");
  if (validLen === -1)
    validLen = len;
  const placeHoldersLen = validLen === len ? 0 : 4 - validLen % 4;
  return [validLen, placeHoldersLen];
};
var _byteLength = function(_b64, validLen, placeHoldersLen) {
  return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
};
var toByteArray = function(b64) {
  let tmp;
  const lens = getLens(b64);
  const validLen = lens[0];
  const placeHoldersLen = lens[1];
  const arr = new Uint8Array(_byteLength(b64, validLen, placeHoldersLen));
  let curByte = 0;
  const len = placeHoldersLen > 0 ? validLen - 4 : validLen;
  let i;
  for (i = 0;i < len; i += 4) {
    tmp = revLookup[b64.charCodeAt(i)] << 18 | revLookup[b64.charCodeAt(i + 1)] << 12 | revLookup[b64.charCodeAt(i + 2)] << 6 | revLookup[b64.charCodeAt(i + 3)];
    arr[curByte++] = tmp >> 16 & 255;
    arr[curByte++] = tmp >> 8 & 255;
    arr[curByte++] = tmp & 255;
  }
  if (placeHoldersLen === 2) {
    tmp = revLookup[b64.charCodeAt(i)] << 2 | revLookup[b64.charCodeAt(i + 1)] >> 4;
    arr[curByte++] = tmp & 255;
  }
  if (placeHoldersLen === 1) {
    tmp = revLookup[b64.charCodeAt(i)] << 10 | revLookup[b64.charCodeAt(i + 1)] << 4 | revLookup[b64.charCodeAt(i + 2)] >> 2;
    arr[curByte++] = tmp >> 8 & 255;
    arr[curByte++] = tmp & 255;
  }
  return arr;
};
var tripletToBase64 = function(num) {
  return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
};
var encodeChunk = function(uint8, start, end) {
  let tmp;
  const output = [];
  for (let i = start;i < end; i += 3) {
    tmp = (uint8[i] << 16 & 16711680) + (uint8[i + 1] << 8 & 65280) + (uint8[i + 2] & 255);
    output.push(tripletToBase64(tmp));
  }
  return output.join("");
};
var fromByteArray = function(uint8) {
  let tmp;
  const len = uint8.length;
  const extraBytes = len % 3;
  const parts = [];
  const maxChunkLength = 16383;
  for (let i = 0, len2 = len - extraBytes;i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, i + maxChunkLength > len2 ? len2 : i + maxChunkLength));
  }
  if (extraBytes === 1) {
    tmp = uint8[len - 1];
    parts.push(lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "==");
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1];
    parts.push(lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "=");
  }
  return parts.join("");
};
var base64clean = function(str) {
  str = str.split("=")[0];
  str = str.trim().replace(INVALID_BASE64_RE, "");
  if (str.length < 2)
    return "";
  while (str.length % 4 !== 0) {
    str = str + "=";
  }
  return str;
};
var notEmpty = function(value) {
  return value !== null && value !== undefined;
};
var compact = function(arr) {
  return arr.filter(notEmpty);
};
var compactObject = function(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => notEmpty(value)));
};
var isBlob = function(value) {
  try {
    return value instanceof Blob;
  } catch (error) {
    return false;
  }
};
var isObject = function(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !isBlob(value);
};
var isDefined = function(value) {
  return value !== null && value !== undefined;
};
var isString = function(value) {
  return isDefined(value) && typeof value === "string";
};
var isStringArray = function(value) {
  return isDefined(value) && Array.isArray(value) && value.every(isString);
};
var isNumber = function(value) {
  return isDefined(value) && typeof value === "number";
};
var parseNumber = function(value) {
  if (isNumber(value)) {
    return value;
  }
  if (isString(value)) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return;
};
var toBase64 = function(value) {
  try {
    return btoa(value);
  } catch (err) {
    const buf = Buffer;
    return buf.from(value).toString("base64");
  }
};
var deepMerge = function(a, b) {
  const result = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (isObject(value) && isObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
};
var chunk = function(array, chunkSize) {
  const result = [];
  for (let i = 0;i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize));
  }
  return result;
};
async function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var timeoutWithCancel = function(ms) {
  let timeoutId;
  const promise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve();
    }, ms);
  });
  return {
    cancel: () => clearTimeout(timeoutId),
    promise
  };
};
var promiseMap = function(inputValues, mapper) {
  const reducer = (acc$, inputValue) => acc$.then((acc) => mapper(inputValue).then((result) => {
    acc.push(result);
    return acc;
  }));
  return inputValues.reduce(reducer, Promise.resolve([]));
};
var getEnvironment = function() {
  try {
    if (isDefined(process) && isDefined(process.env)) {
      return {
        apiKey: process.env.XATA_API_KEY ?? getGlobalApiKey(),
        databaseURL: process.env.XATA_DATABASE_URL ?? getGlobalDatabaseURL(),
        branch: process.env.XATA_BRANCH ?? getGlobalBranch(),
        deployPreview: process.env.XATA_PREVIEW,
        deployPreviewBranch: process.env.XATA_PREVIEW_BRANCH,
        vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
        vercelGitRepoOwner: process.env.VERCEL_GIT_REPO_OWNER
      };
    }
  } catch (err) {
  }
  try {
    if (isObject(Deno) && isObject(Deno.env)) {
      return {
        apiKey: Deno.env.get("XATA_API_KEY") ?? getGlobalApiKey(),
        databaseURL: Deno.env.get("XATA_DATABASE_URL") ?? getGlobalDatabaseURL(),
        branch: Deno.env.get("XATA_BRANCH") ?? getGlobalBranch(),
        deployPreview: Deno.env.get("XATA_PREVIEW"),
        deployPreviewBranch: Deno.env.get("XATA_PREVIEW_BRANCH"),
        vercelGitCommitRef: Deno.env.get("VERCEL_GIT_COMMIT_REF"),
        vercelGitRepoOwner: Deno.env.get("VERCEL_GIT_REPO_OWNER")
      };
    }
  } catch (err) {
  }
  return {
    apiKey: getGlobalApiKey(),
    databaseURL: getGlobalDatabaseURL(),
    branch: getGlobalBranch(),
    deployPreview: undefined,
    deployPreviewBranch: undefined,
    vercelGitCommitRef: undefined,
    vercelGitRepoOwner: undefined
  };
};
var getEnableBrowserVariable = function() {
  try {
    if (isObject(process) && isObject(process.env) && process.env.XATA_ENABLE_BROWSER !== undefined) {
      return process.env.XATA_ENABLE_BROWSER === "true";
    }
  } catch (err) {
  }
  try {
    if (isObject(Deno) && isObject(Deno.env) && Deno.env.get("XATA_ENABLE_BROWSER") !== undefined) {
      return Deno.env.get("XATA_ENABLE_BROWSER") === "true";
    }
  } catch (err) {
  }
  try {
    return XATA_ENABLE_BROWSER === true || XATA_ENABLE_BROWSER === "true";
  } catch (err) {
    return;
  }
};
var getGlobalApiKey = function() {
  try {
    return XATA_API_KEY;
  } catch (err) {
    return;
  }
};
var getGlobalDatabaseURL = function() {
  try {
    return XATA_DATABASE_URL;
  } catch (err) {
    return;
  }
};
var getGlobalBranch = function() {
  try {
    return XATA_BRANCH;
  } catch (err) {
    return;
  }
};
var getDatabaseURL = function() {
  try {
    const { databaseURL } = getEnvironment();
    return databaseURL;
  } catch (err) {
    return;
  }
};
var getAPIKey = function() {
  try {
    const { apiKey } = getEnvironment();
    return apiKey;
  } catch (err) {
    return;
  }
};
var getBranch = function() {
  try {
    const { branch } = getEnvironment();
    return branch;
  } catch (err) {
    return;
  }
};
var buildPreviewBranchName = function({ org, branch }) {
  return `preview-${org}-${branch}`;
};
var getPreviewBranch = function() {
  try {
    const { deployPreview, deployPreviewBranch, vercelGitCommitRef, vercelGitRepoOwner } = getEnvironment();
    if (deployPreviewBranch)
      return deployPreviewBranch;
    switch (deployPreview) {
      case "vercel": {
        if (!vercelGitCommitRef || !vercelGitRepoOwner) {
          console.warn("XATA_PREVIEW=vercel but VERCEL_GIT_COMMIT_REF or VERCEL_GIT_REPO_OWNER is not valid");
          return;
        }
        return buildPreviewBranchName({ org: vercelGitRepoOwner, branch: vercelGitCommitRef });
      }
    }
    return;
  } catch (err) {
    return;
  }
};
var getFetchImplementation = function(userFetch) {
  const globalFetch = typeof fetch !== "undefined" ? fetch : undefined;
  const globalThisFetch = typeof globalThis !== "undefined" ? globalThis.fetch : undefined;
  const fetchImpl = userFetch ?? globalFetch ?? globalThisFetch;
  if (!fetchImpl) {
    throw new Error(`Couldn't find a global \`fetch\`. Pass a fetch implementation explicitly.`);
  }
  return fetchImpl;
};
var generateUUID = function() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c == "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
};
async function getBytes(stream, onChunk) {
  const reader = stream.getReader();
  let result;
  while (!(result = await reader.read()).done) {
    onChunk(result.value);
  }
}
var getLines = function(onLine) {
  let buffer;
  let position;
  let fieldLength;
  let discardTrailingNewline = false;
  return function onChunk(arr) {
    if (buffer === undefined) {
      buffer = arr;
      position = 0;
      fieldLength = -1;
    } else {
      buffer = concat(buffer, arr);
    }
    const bufLength = buffer.length;
    let lineStart = 0;
    while (position < bufLength) {
      if (discardTrailingNewline) {
        if (buffer[position] === 10) {
          lineStart = ++position;
        }
        discardTrailingNewline = false;
      }
      let lineEnd = -1;
      for (;position < bufLength && lineEnd === -1; ++position) {
        switch (buffer[position]) {
          case 58:
            if (fieldLength === -1) {
              fieldLength = position - lineStart;
            }
            break;
          case 13:
            discardTrailingNewline = true;
          case 10:
            lineEnd = position;
            break;
        }
      }
      if (lineEnd === -1) {
        break;
      }
      onLine(buffer.subarray(lineStart, lineEnd), fieldLength);
      lineStart = position;
      fieldLength = -1;
    }
    if (lineStart === bufLength) {
      buffer = undefined;
    } else if (lineStart !== 0) {
      buffer = buffer.subarray(lineStart);
      position -= lineStart;
    }
  };
};
var getMessages = function(onId, onRetry, onMessage) {
  let message = newMessage();
  const decoder = new TextDecoder;
  return function onLine(line, fieldLength) {
    if (line.length === 0) {
      onMessage?.(message);
      message = newMessage();
    } else if (fieldLength > 0) {
      const field = decoder.decode(line.subarray(0, fieldLength));
      const valueOffset = fieldLength + (line[fieldLength + 1] === 32 ? 2 : 1);
      const value = decoder.decode(line.subarray(valueOffset));
      switch (field) {
        case "data":
          message.data = message.data ? message.data + "\n" + value : value;
          break;
        case "event":
          message.event = value;
          break;
        case "id":
          onId(message.id = value);
          break;
        case "retry":
          const retry = parseInt(value, 10);
          if (!isNaN(retry)) {
            onRetry(message.retry = retry);
          }
          break;
      }
    }
  };
};
var concat = function(a, b) {
  const res = new Uint8Array(a.length + b.length);
  res.set(a);
  res.set(b, a.length);
  return res;
};
var newMessage = function() {
  return {
    data: "",
    event: "",
    id: "",
    retry: undefined
  };
};
var fetchEventSource = function(input, {
  signal: inputSignal,
  headers: inputHeaders,
  onopen: inputOnOpen,
  onmessage,
  onclose,
  onerror,
  fetch: inputFetch,
  ...rest
}) {
  return new Promise((resolve, reject) => {
    const headers = { ...inputHeaders };
    if (!headers.accept) {
      headers.accept = EventStreamContentType;
    }
    let curRequestController;
    function dispose() {
      curRequestController.abort();
    }
    inputSignal?.addEventListener("abort", () => {
      dispose();
      resolve();
    });
    const fetchImpl = inputFetch ?? fetch;
    const onopen = inputOnOpen ?? defaultOnOpen;
    async function create() {
      curRequestController = new AbortController;
      try {
        const response = await fetchImpl(input, {
          ...rest,
          headers,
          signal: curRequestController.signal
        });
        await onopen(response);
        await getBytes(response.body, getLines(getMessages((id) => {
          if (id) {
            headers[LastEventId] = id;
          } else {
            delete headers[LastEventId];
          }
        }, (_retry) => {
        }, onmessage)));
        onclose?.();
        dispose();
        resolve();
      } catch (err) {
      }
    }
    create();
  });
};
var defaultOnOpen = function(response) {
  const contentType = response.headers?.get("content-type");
  if (!contentType?.startsWith(EventStreamContentType)) {
    throw new Error(`Expected content-type to be ${EventStreamContentType}, Actual: ${contentType}`);
  }
};
var isBulkError = function(error) {
  return isObject(error) && Array.isArray(error.errors);
};
var isErrorWithMessage = function(error) {
  return isObject(error) && isString(error.message);
};
var getMessage = function(data) {
  if (data instanceof Error) {
    return data.message;
  } else if (isString(data)) {
    return data;
  } else if (isErrorWithMessage(data)) {
    return data.message;
  } else if (isBulkError(data)) {
    return "Bulk operation failed";
  } else {
    return "Unexpected error";
  }
};
var isHostProviderAlias = function(alias) {
  return isString(alias) && Object.keys(providers).includes(alias);
};
var parseWorkspacesUrlParts = function(url6) {
  if (!isString(url6))
    return null;
  const matches = {
    production: url6.match(/(?:https:\/\/)?([^.]+)(?:\.([^.]+))\.xata\.sh\/db\/([^:]+):?(.*)?/),
    staging: url6.match(/(?:https:\/\/)?([^.]+)(?:\.([^.]+))\.staging-xata\.dev\/db\/([^:]+):?(.*)?/),
    dev: url6.match(/(?:https:\/\/)?([^.]+)(?:\.([^.]+))\.dev-xata\.dev\/db\/([^:]+):?(.*)?/),
    local: url6.match(/(?:https?:\/\/)?([^.]+)(?:\.([^.]+))\.localhost:(?:\d+)\/db\/([^:]+):?(.*)?/)
  };
  const [host, match] = Object.entries(matches).find(([, match2]) => match2 !== null) ?? [];
  if (!isHostProviderAlias(host) || !match)
    return null;
  return { workspace: match[1], region: match[2], database: match[3], branch: match[4], host };
};
var buildBaseUrl = function({
  method,
  endpoint,
  path,
  workspacesApiUrl,
  apiUrl,
  pathParams = {}
}) {
  if (endpoint === "dataPlane") {
    let url6 = isString(workspacesApiUrl) ? `${workspacesApiUrl}${path}` : workspacesApiUrl(path, pathParams);
    if (method.toUpperCase() === "PUT" && [
      "/db/{dbBranchName}/tables/{tableName}/data/{recordId}/column/{columnName}/file",
      "/db/{dbBranchName}/tables/{tableName}/data/{recordId}/column/{columnName}/file/{fileId}"
    ].includes(path)) {
      const { host } = parseWorkspacesUrlParts(url6) ?? {};
      switch (host) {
        case "production":
          url6 = url6.replace("xata.sh", "upload.xata.sh");
          break;
        case "staging":
          url6 = url6.replace("staging-xata.dev", "upload.staging-xata.dev");
          break;
        case "dev":
          url6 = url6.replace("dev-xata.dev", "upload.dev-xata.dev");
          break;
      }
    }
    const urlWithWorkspace = isString(pathParams.workspace) ? url6.replace("{workspaceId}", String(pathParams.workspace)) : url6;
    return isString(pathParams.region) ? urlWithWorkspace.replace("{region}", String(pathParams.region)) : urlWithWorkspace;
  }
  return `${apiUrl}${path}`;
};
var hostHeader = function(url6) {
  const pattern = /.*:\/\/(?<host>[^/]+).*/;
  const { groups } = pattern.exec(url6) ?? {};
  return groups?.host ? { Host: groups.host } : {};
};
async function parseBody2(body2, headers) {
  if (!isDefined(body2))
    return;
  if (isBlob(body2) || typeof body2.text === "function") {
    return body2;
  }
  const { "Content-Type": contentType } = headers ?? {};
  if (String(contentType).toLowerCase() === "application/json" && isObject(body2)) {
    return JSON.stringify(body2);
  }
  return body2;
}
async function fetch$1({
  url: path,
  method,
  body: body2,
  headers: customHeaders,
  pathParams,
  queryParams,
  fetch: fetch2,
  apiKey,
  endpoint,
  apiUrl,
  workspacesApiUrl,
  trace,
  signal,
  clientID,
  sessionID,
  clientName,
  xataAgentExtra,
  fetchOptions = {},
  rawResponse = false
}) {
  pool.setFetch(fetch2);
  return await trace(`${method.toUpperCase()} ${path}`, async ({ setAttributes }) => {
    const baseUrl = buildBaseUrl({ method, endpoint, path, workspacesApiUrl, pathParams, apiUrl });
    const fullUrl = resolveUrl(baseUrl, queryParams, pathParams);
    const url6 = fullUrl.includes("localhost") ? fullUrl.replace(/^[^.]+\.[^.]+\./, "http://") : fullUrl;
    setAttributes({
      [TraceAttributes.HTTP_URL]: url6,
      [TraceAttributes.HTTP_TARGET]: resolveUrl(path, queryParams, pathParams)
    });
    const xataAgent = compact([
      ["client", "TS_SDK"],
      ["version", VERSION],
      isDefined(clientName) ? ["service", clientName] : undefined,
      ...Object.entries(xataAgentExtra ?? {})
    ]).map(([key, value]) => `${key}=${value}`).join("; ");
    const headers = compactObject({
      "Accept-Encoding": "identity",
      "Content-Type": "application/json",
      "X-Xata-Client-ID": clientID ?? defaultClientID,
      "X-Xata-Session-ID": sessionID ?? generateUUID(),
      "X-Xata-Agent": xataAgent,
      ...customHeaders,
      ...hostHeader(fullUrl),
      Authorization: `Bearer ${apiKey}`
    });
    const response = await pool.request(url6, {
      ...fetchOptions,
      method: method.toUpperCase(),
      body: await parseBody2(body2, headers),
      headers,
      signal
    });
    const { host, protocol } = parseUrl(response.url);
    const requestId = response.headers?.get("x-request-id") ?? undefined;
    setAttributes({
      [TraceAttributes.KIND]: "http",
      [TraceAttributes.HTTP_REQUEST_ID]: requestId,
      [TraceAttributes.HTTP_STATUS_CODE]: response.status,
      [TraceAttributes.HTTP_HOST]: host,
      [TraceAttributes.HTTP_SCHEME]: protocol?.replace(":", ""),
      [TraceAttributes.CLOUDFLARE_RAY_ID]: response.headers?.get("cf-ray") ?? undefined
    });
    const message = response.headers?.get("x-xata-message");
    if (message)
      console.warn(message);
    if (response.status === 204) {
      return {};
    }
    if (response.status === 429) {
      throw new FetcherError(response.status, "Rate limit exceeded", requestId);
    }
    try {
      const jsonResponse = rawResponse ? await response.blob() : await response.json();
      if (response.ok) {
        return jsonResponse;
      }
      throw new FetcherError(response.status, jsonResponse, requestId);
    } catch (error) {
      throw new FetcherError(response.status, error, requestId);
    }
  }, { [TraceAttributes.HTTP_METHOD]: method.toUpperCase(), [TraceAttributes.HTTP_ROUTE]: path });
}
var fetchSSERequest = function({
  url: path,
  method,
  body: body2,
  headers: customHeaders,
  pathParams,
  queryParams,
  fetch: fetch2,
  apiKey,
  endpoint,
  apiUrl,
  workspacesApiUrl,
  onMessage,
  onError,
  onClose,
  signal,
  clientID,
  sessionID,
  clientName,
  xataAgentExtra
}) {
  const baseUrl = buildBaseUrl({ method, endpoint, path, workspacesApiUrl, pathParams, apiUrl });
  const fullUrl = resolveUrl(baseUrl, queryParams, pathParams);
  const url6 = fullUrl.includes("localhost") ? fullUrl.replace(/^[^.]+\./, "http://") : fullUrl;
  fetchEventSource(url6, {
    method,
    body: JSON.stringify(body2),
    fetch: fetch2,
    signal,
    headers: {
      "X-Xata-Client-ID": clientID ?? defaultClientID,
      "X-Xata-Session-ID": sessionID ?? generateUUID(),
      "X-Xata-Agent": compact([
        ["client", "TS_SDK"],
        ["version", VERSION],
        isDefined(clientName) ? ["service", clientName] : undefined,
        ...Object.entries(xataAgentExtra ?? {})
      ]).map(([key, value]) => `${key}=${value}`).join("; "),
      ...customHeaders,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    onmessage(ev) {
      onMessage?.(JSON.parse(ev.data));
    },
    onerror(ev) {
      onError?.(JSON.parse(ev.data));
    },
    onclose() {
      onClose?.();
    }
  });
};
var parseUrl = function(url6) {
  try {
    const { host, protocol } = new URL(url6);
    return { host, protocol };
  } catch (error) {
    return {};
  }
};
var buildTransformString = function(transformations) {
  return transformations.flatMap((t) => Object.entries(t).map(([key, value]) => {
    if (key === "trim") {
      const { left = 0, top = 0, right = 0, bottom = 0 } = value;
      return `${key}=${[top, right, bottom, left].join(";")}`;
    }
    if (key === "gravity" && typeof value === "object") {
      const { x = 0.5, y = 0.5 } = value;
      return `${key}=${[x, y].join("x")}`;
    }
    return `${key}=${value}`;
  })).join(",");
};
var transformImage = function(url6, ...transformations) {
  if (!isDefined(url6))
    return;
  const newTransformations = buildTransformString(transformations);
  const { hostname, pathname, search } = new URL(url6);
  const pathParts = pathname.split("/");
  const transformIndex = pathParts.findIndex((part) => part === "transform");
  const removedItems = transformIndex >= 0 ? pathParts.splice(transformIndex, 2) : [];
  const transform = `/transform/${[removedItems[1], newTransformations].filter(isDefined).join(",")}`;
  const path = pathParts.join("/");
  return `https://${hostname}${transform}${path}${search}`;
};
var cleanFilter = function(filter) {
  if (!isDefined(filter))
    return;
  if (!isObject(filter))
    return filter;
  const values = Object.fromEntries(Object.entries(filter).reduce((acc, [key, value]) => {
    if (!isDefined(value))
      return acc;
    if (Array.isArray(value)) {
      const clean = value.map((item) => cleanFilter(item)).filter((item) => isDefined(item));
      if (clean.length === 0)
        return acc;
      return [...acc, [key, clean]];
    }
    if (isObject(value)) {
      const clean = cleanFilter(value);
      if (!isDefined(clean))
        return acc;
      return [...acc, [key, clean]];
    }
    return [...acc, [key, value]];
  }, []));
  return Object.keys(values).length > 0 ? values : undefined;
};
var stringifyJson = function(value) {
  if (!isDefined(value))
    return value;
  if (isString(value))
    return value;
  try {
    return JSON.stringify(value);
  } catch (e) {
    return value;
  }
};
var parseJson = function(value) {
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
};
var isCursorPaginationOptions = function(options) {
  return isDefined(options) && (isDefined(options.start) || isDefined(options.end) || isDefined(options.after) || isDefined(options.before));
};
var cleanParent = function(data, parent) {
  if (isCursorPaginationOptions(data.pagination)) {
    return { ...parent, sort: undefined, filter: undefined };
  }
  return parent;
};
var isIdentifiable = function(x) {
  return isObject(x) && isString(x?.id);
};
var isValidExpandedColumn = function(column) {
  return isObject(column) && isString(column.name);
};
var isValidSelectableColumns = function(columns) {
  if (!Array.isArray(columns)) {
    return false;
  }
  return columns.every((column) => {
    if (typeof column === "string") {
      return true;
    }
    if (typeof column === "object") {
      return isValidExpandedColumn(column);
    }
    return false;
  });
};
var isSortFilterString = function(value) {
  return isString(value);
};
var isSortFilterBase = function(filter) {
  return isObject(filter) && Object.entries(filter).every(([key, value]) => {
    if (key === "*")
      return value === "random";
    return value === "asc" || value === "desc";
  });
};
var isSortFilterObject = function(filter) {
  return isObject(filter) && !isSortFilterBase(filter) && filter.column !== undefined;
};
var buildSortFilter = function(filter) {
  if (isSortFilterString(filter)) {
    return { [filter]: "asc" };
  } else if (Array.isArray(filter)) {
    return filter.map((item) => buildSortFilter(item));
  } else if (isSortFilterBase(filter)) {
    return filter;
  } else if (isSortFilterObject(filter)) {
    return { [filter.column]: filter.direction ?? "asc" };
  } else {
    throw new Error(`Invalid sort filter: ${filter}`);
  }
};
var extractId = function(value) {
  if (isString(value))
    return value;
  if (isObject(value) && isString(value.id))
    return value.id;
  return;
};
var isValidColumn = function(columns, column) {
  if (columns.includes("*"))
    return true;
  return columns.filter((item) => isString(item) && item.startsWith(column.name)).length > 0;
};
var parseIfVersion = function(...args) {
  for (const arg of args) {
    if (isObject(arg) && isNumber(arg.ifVersion)) {
      return arg.ifVersion;
    }
  }
  return;
};
var getContentType = function(file) {
  if (typeof file === "string") {
    return "text/plain";
  }
  if ("mediaType" in file && file.mediaType !== undefined) {
    return file.mediaType;
  }
  if (isBlob(file)) {
    return file.type;
  }
  try {
    return file.type;
  } catch (e) {
  }
  return "application/octet-stream";
};
var escapeElement = function(elementRepresentation) {
  const escaped = elementRepresentation.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return '"' + escaped + '"';
};
var arrayString = function(val) {
  let result = "{";
  for (let i = 0;i < val.length; i++) {
    if (i > 0) {
      result = result + ",";
    }
    if (val[i] === null || typeof val[i] === "undefined") {
      result = result + "NULL";
    } else if (Array.isArray(val[i])) {
      result = result + arrayString(val[i]);
    } else if (val[i] instanceof Buffer) {
      result += "\\\\x" + val[i].toString("hex");
    } else {
      result += escapeElement(prepareValue(val[i]));
    }
  }
  result = result + "}";
  return result;
};
var prepareValue = function(value) {
  if (!isDefined(value))
    return null;
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return arrayString(value);
  }
  if (isObject(value)) {
    return JSON.stringify(value);
  }
  try {
    return value.toString();
  } catch (e) {
    return value;
  }
};
var prepareParams = function(param1, param2) {
  if (isString(param1)) {
    return { statement: param1, params: param2?.map((value) => prepareValue(value)) };
  }
  if (isStringArray(param1)) {
    const statement = param1.reduce((acc, curr, index) => {
      return acc + curr + (index < (param2?.length ?? 0) ? "$" + (index + 1) : "");
    }, "");
    return { statement, params: param2?.map((value) => prepareValue(value)) };
  }
  if (isObject(param1)) {
    const { statement, params, consistency, responseType } = param1;
    return { statement, params: params?.map((value) => prepareValue(value)), consistency, responseType };
  }
  throw new Error("Invalid query");
};
var isTemplateStringsArray = function(strings) {
  return Array.isArray(strings) && "raw" in strings && Array.isArray(strings.raw);
};
var isParamsObject = function(params) {
  return isObject(params) && "statement" in params;
};
var buildDomain = function(host, region) {
  switch (host) {
    case "production":
      return `${region}.sql.xata.sh`;
    case "staging":
      return `${region}.sql.staging-xata.dev`;
    case "dev":
      return `${region}.sql.dev-xata.dev`;
    case "local":
      return "localhost:7654";
    default:
      throw new Error("Invalid host provider");
  }
};
var buildConnectionString = function({ apiKey, workspacesApiUrl, branch }) {
  const url6 = isString(workspacesApiUrl) ? workspacesApiUrl : workspacesApiUrl("", {});
  const parts = parseWorkspacesUrlParts(url6);
  if (!parts)
    throw new Error("Invalid workspaces URL");
  const { workspace: workspaceSlug, region, database, host } = parts;
  const domain = buildDomain(host, region);
  const workspace = workspaceSlug.split("-").pop();
  if (!workspace || !region || !database || !apiKey || !branch) {
    throw new Error("Unable to build xata connection string");
  }
  return `postgresql://${workspace}:${apiKey}@${domain}/${database}:${branch}?sslmode=require`;
};
var defaultTrace = async (name, fn, _options) => {
  return await fn({
    name,
    setAttributes: () => {
      return;
    }
  });
};
var TraceAttributes = {
  KIND: "xata.trace.kind",
  VERSION: "xata.sdk.version",
  TABLE: "xata.table",
  HTTP_REQUEST_ID: "http.request_id",
  HTTP_STATUS_CODE: "http.status_code",
  HTTP_HOST: "http.host",
  HTTP_SCHEME: "http.scheme",
  HTTP_USER_AGENT: "http.user_agent",
  HTTP_METHOD: "http.method",
  HTTP_URL: "http.url",
  HTTP_ROUTE: "http.route",
  HTTP_TARGET: "http.target",
  CLOUDFLARE_RAY_ID: "cf.ray"
};
var lookup = [];
var revLookup = [];
var code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (let i = 0, len = code.length;i < len; ++i) {
  lookup[i] = code[i];
  revLookup[code.charCodeAt(i)] = i;
}
revLookup["-".charCodeAt(0)] = 62;
revLookup["_".charCodeAt(0)] = 63;
var K_MAX_LENGTH = 2147483647;
var MAX_ARGUMENTS_LENGTH = 4096;

class Buffer extends Uint8Array {
  constructor(value, encodingOrOffset, length) {
    if (typeof value === "number") {
      if (typeof encodingOrOffset === "string") {
        throw new TypeError("The first argument must be of type string, received type number");
      }
      if (value < 0) {
        throw new RangeError("The buffer size cannot be negative");
      }
      super(value < 0 ? 0 : Buffer._checked(value) | 0);
    } else if (typeof value === "string") {
      if (typeof encodingOrOffset !== "string") {
        encodingOrOffset = "utf8";
      }
      if (!Buffer.isEncoding(encodingOrOffset)) {
        throw new TypeError("Unknown encoding: " + encodingOrOffset);
      }
      const length2 = Buffer.byteLength(value, encodingOrOffset) | 0;
      super(length2);
      const written = this.write(value, 0, this.length, encodingOrOffset);
      if (written !== length2) {
        throw new TypeError("Number of bytes written did not match expected length (wrote " + written + ", expected " + length2 + ")");
      }
    } else if (ArrayBuffer.isView(value)) {
      if (Buffer._isInstance(value, Uint8Array)) {
        const copy = new Uint8Array(value);
        const array = copy.buffer;
        const byteOffset = copy.byteOffset;
        const length2 = copy.byteLength;
        if (byteOffset < 0 || array.byteLength < byteOffset) {
          throw new RangeError("offset is outside of buffer bounds");
        }
        if (array.byteLength < byteOffset + (length2 || 0)) {
          throw new RangeError("length is outside of buffer bounds");
        }
        super(new Uint8Array(array, byteOffset, length2));
      } else {
        const array = value;
        const length2 = array.length < 0 ? 0 : Buffer._checked(array.length) | 0;
        super(new Uint8Array(length2));
        for (let i = 0;i < length2; i++) {
          this[i] = array[i] & 255;
        }
      }
    } else if (value == null) {
      throw new TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value);
    } else if (Buffer._isInstance(value, ArrayBuffer) || value && Buffer._isInstance(value.buffer, ArrayBuffer)) {
      const array = value;
      const byteOffset = encodingOrOffset;
      if (byteOffset < 0 || array.byteLength < byteOffset) {
        throw new RangeError("offset is outside of buffer bounds");
      }
      if (array.byteLength < byteOffset + (length || 0)) {
        throw new RangeError("length is outside of buffer bounds");
      }
      super(new Uint8Array(array, byteOffset, length));
    } else if (Array.isArray(value)) {
      const array = value;
      const length2 = array.length < 0 ? 0 : Buffer._checked(array.length) | 0;
      super(new Uint8Array(length2));
      for (let i = 0;i < length2; i++) {
        this[i] = array[i] & 255;
      }
    } else {
      throw new TypeError("Unable to determine the correct way to allocate buffer for type " + typeof value);
    }
  }
  toJSON() {
    return {
      type: "Buffer",
      data: Array.prototype.slice.call(this)
    };
  }
  write(string, offset, length, encoding) {
    if (typeof offset === "undefined") {
      encoding = "utf8";
      length = this.length;
      offset = 0;
    } else if (typeof length === "undefined" && typeof offset === "string") {
      encoding = offset;
      length = this.length;
      offset = 0;
    } else if (typeof offset === "number" && isFinite(offset)) {
      offset = offset >>> 0;
      if (typeof length === "number" && isFinite(length)) {
        length = length >>> 0;
        encoding ?? (encoding = "utf8");
      } else if (typeof length === "string") {
        encoding = length;
        length = undefined;
      }
    } else {
      throw new Error("Buffer.write(string, encoding, offset[, length]) is no longer supported");
    }
    const remaining = this.length - offset;
    if (typeof length === "undefined" || length > remaining) {
      length = remaining;
    }
    if (string.length > 0 && (length < 0 || offset < 0) || offset > this.length) {
      throw new RangeError("Attempt to write outside buffer bounds");
    }
    encoding || (encoding = "utf8");
    switch (Buffer._getEncoding(encoding)) {
      case "hex":
        return Buffer._hexWrite(this, string, offset, length);
      case "utf8":
        return Buffer._utf8Write(this, string, offset, length);
      case "ascii":
      case "latin1":
      case "binary":
        return Buffer._asciiWrite(this, string, offset, length);
      case "ucs2":
      case "utf16le":
        return Buffer._ucs2Write(this, string, offset, length);
      case "base64":
        return Buffer._base64Write(this, string, offset, length);
    }
  }
  toString(encoding, start, end) {
    const length = this.length;
    if (length === 0) {
      return "";
    }
    if (arguments.length === 0) {
      return Buffer._utf8Slice(this, 0, length);
    }
    if (typeof start === "undefined" || start < 0) {
      start = 0;
    }
    if (start > this.length) {
      return "";
    }
    if (typeof end === "undefined" || end > this.length) {
      end = this.length;
    }
    if (end <= 0) {
      return "";
    }
    end >>>= 0;
    start >>>= 0;
    if (end <= start) {
      return "";
    }
    if (!encoding) {
      encoding = "utf8";
    }
    switch (Buffer._getEncoding(encoding)) {
      case "hex":
        return Buffer._hexSlice(this, start, end);
      case "utf8":
        return Buffer._utf8Slice(this, start, end);
      case "ascii":
        return Buffer._asciiSlice(this, start, end);
      case "latin1":
      case "binary":
        return Buffer._latin1Slice(this, start, end);
      case "ucs2":
      case "utf16le":
        return Buffer._utf16leSlice(this, start, end);
      case "base64":
        return Buffer._base64Slice(this, start, end);
    }
  }
  equals(otherBuffer) {
    if (!Buffer.isBuffer(otherBuffer)) {
      throw new TypeError("Argument must be a Buffer");
    }
    if (this === otherBuffer) {
      return true;
    }
    return Buffer.compare(this, otherBuffer) === 0;
  }
  compare(otherBuffer, targetStart, targetEnd, sourceStart, sourceEnd) {
    if (Buffer._isInstance(otherBuffer, Uint8Array)) {
      otherBuffer = Buffer.from(otherBuffer, otherBuffer.byteOffset, otherBuffer.byteLength);
    }
    if (!Buffer.isBuffer(otherBuffer)) {
      throw new TypeError("Argument must be a Buffer or Uint8Array");
    }
    targetStart ?? (targetStart = 0);
    targetEnd ?? (targetEnd = otherBuffer ? otherBuffer.length : 0);
    sourceStart ?? (sourceStart = 0);
    sourceEnd ?? (sourceEnd = this.length);
    if (targetStart < 0 || targetEnd > otherBuffer.length || sourceStart < 0 || sourceEnd > this.length) {
      throw new RangeError("Out of range index");
    }
    if (sourceStart >= sourceEnd && targetStart >= targetEnd) {
      return 0;
    }
    if (sourceStart >= sourceEnd) {
      return -1;
    }
    if (targetStart >= targetEnd) {
      return 1;
    }
    targetStart >>>= 0;
    targetEnd >>>= 0;
    sourceStart >>>= 0;
    sourceEnd >>>= 0;
    if (this === otherBuffer) {
      return 0;
    }
    let x = sourceEnd - sourceStart;
    let y = targetEnd - targetStart;
    const len = Math.min(x, y);
    const thisCopy = this.slice(sourceStart, sourceEnd);
    const targetCopy = otherBuffer.slice(targetStart, targetEnd);
    for (let i = 0;i < len; ++i) {
      if (thisCopy[i] !== targetCopy[i]) {
        x = thisCopy[i];
        y = targetCopy[i];
        break;
      }
    }
    if (x < y)
      return -1;
    if (y < x)
      return 1;
    return 0;
  }
  copy(targetBuffer, targetStart, sourceStart, sourceEnd) {
    if (!Buffer.isBuffer(targetBuffer))
      throw new TypeError("argument should be a Buffer");
    if (!sourceStart)
      sourceStart = 0;
    if (!targetStart)
      targetStart = 0;
    if (!sourceEnd && sourceEnd !== 0)
      sourceEnd = this.length;
    if (targetStart >= targetBuffer.length)
      targetStart = targetBuffer.length;
    if (!targetStart)
      targetStart = 0;
    if (sourceEnd > 0 && sourceEnd < sourceStart)
      sourceEnd = sourceStart;
    if (sourceEnd === sourceStart)
      return 0;
    if (targetBuffer.length === 0 || this.length === 0)
      return 0;
    if (targetStart < 0) {
      throw new RangeError("targetStart out of bounds");
    }
    if (sourceStart < 0 || sourceStart >= this.length)
      throw new RangeError("Index out of range");
    if (sourceEnd < 0)
      throw new RangeError("sourceEnd out of bounds");
    if (sourceEnd > this.length)
      sourceEnd = this.length;
    if (targetBuffer.length - targetStart < sourceEnd - sourceStart) {
      sourceEnd = targetBuffer.length - targetStart + sourceStart;
    }
    const len = sourceEnd - sourceStart;
    if (this === targetBuffer && typeof Uint8Array.prototype.copyWithin === "function") {
      this.copyWithin(targetStart, sourceStart, sourceEnd);
    } else {
      Uint8Array.prototype.set.call(targetBuffer, this.subarray(sourceStart, sourceEnd), targetStart);
    }
    return len;
  }
  slice(start, end) {
    if (!start) {
      start = 0;
    }
    const len = this.length;
    start = ~~start;
    end = end === undefined ? len : ~~end;
    if (start < 0) {
      start += len;
      if (start < 0) {
        start = 0;
      }
    } else if (start > len) {
      start = len;
    }
    if (end < 0) {
      end += len;
      if (end < 0) {
        end = 0;
      }
    } else if (end > len) {
      end = len;
    }
    if (end < start) {
      end = start;
    }
    const newBuf = this.subarray(start, end);
    Object.setPrototypeOf(newBuf, Buffer.prototype);
    return newBuf;
  }
  writeUIntLE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset >>> 0;
    byteLength = byteLength >>> 0;
    if (!noAssert) {
      const maxBytes = Math.pow(2, 8 * byteLength) - 1;
      Buffer._checkInt(this, value, offset, byteLength, maxBytes, 0);
    }
    let mul = 1;
    let i = 0;
    this[offset] = value & 255;
    while (++i < byteLength && (mul *= 256)) {
      this[offset + i] = value / mul & 255;
    }
    return offset + byteLength;
  }
  writeUIntBE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset >>> 0;
    byteLength = byteLength >>> 0;
    if (!noAssert) {
      const maxBytes = Math.pow(2, 8 * byteLength) - 1;
      Buffer._checkInt(this, value, offset, byteLength, maxBytes, 0);
    }
    let i = byteLength - 1;
    let mul = 1;
    this[offset + i] = value & 255;
    while (--i >= 0 && (mul *= 256)) {
      this[offset + i] = value / mul & 255;
    }
    return offset + byteLength;
  }
  writeIntLE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      const limit = Math.pow(2, 8 * byteLength - 1);
      Buffer._checkInt(this, value, offset, byteLength, limit - 1, -limit);
    }
    let i = 0;
    let mul = 1;
    let sub = 0;
    this[offset] = value & 255;
    while (++i < byteLength && (mul *= 256)) {
      if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
        sub = 1;
      }
      this[offset + i] = (value / mul >> 0) - sub & 255;
    }
    return offset + byteLength;
  }
  writeIntBE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      const limit = Math.pow(2, 8 * byteLength - 1);
      Buffer._checkInt(this, value, offset, byteLength, limit - 1, -limit);
    }
    let i = byteLength - 1;
    let mul = 1;
    let sub = 0;
    this[offset + i] = value & 255;
    while (--i >= 0 && (mul *= 256)) {
      if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
        sub = 1;
      }
      this[offset + i] = (value / mul >> 0) - sub & 255;
    }
    return offset + byteLength;
  }
  readUIntLE(offset, byteLength, noAssert) {
    offset = offset >>> 0;
    byteLength = byteLength >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, byteLength, this.length);
    }
    let val = this[offset];
    let mul = 1;
    let i = 0;
    while (++i < byteLength && (mul *= 256)) {
      val += this[offset + i] * mul;
    }
    return val;
  }
  readUIntBE(offset, byteLength, noAssert) {
    offset = offset >>> 0;
    byteLength = byteLength >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, byteLength, this.length);
    }
    let val = this[offset + --byteLength];
    let mul = 1;
    while (byteLength > 0 && (mul *= 256)) {
      val += this[offset + --byteLength] * mul;
    }
    return val;
  }
  readIntLE(offset, byteLength, noAssert) {
    offset = offset >>> 0;
    byteLength = byteLength >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, byteLength, this.length);
    }
    let val = this[offset];
    let mul = 1;
    let i = 0;
    while (++i < byteLength && (mul *= 256)) {
      val += this[offset + i] * mul;
    }
    mul *= 128;
    if (val >= mul) {
      val -= Math.pow(2, 8 * byteLength);
    }
    return val;
  }
  readIntBE(offset, byteLength, noAssert) {
    offset = offset >>> 0;
    byteLength = byteLength >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, byteLength, this.length);
    }
    let i = byteLength;
    let mul = 1;
    let val = this[offset + --i];
    while (i > 0 && (mul *= 256)) {
      val += this[offset + --i] * mul;
    }
    mul *= 128;
    if (val >= mul) {
      val -= Math.pow(2, 8 * byteLength);
    }
    return val;
  }
  readUInt8(offset, noAssert) {
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, 1, this.length);
    }
    return this[offset];
  }
  readUInt16LE(offset, noAssert) {
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, 2, this.length);
    }
    return this[offset] | this[offset + 1] << 8;
  }
  readUInt16BE(offset, noAssert) {
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, 2, this.length);
    }
    return this[offset] << 8 | this[offset + 1];
  }
  readUInt32LE(offset, noAssert) {
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, 4, this.length);
    }
    return (this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16) + this[offset + 3] * 16777216;
  }
  readUInt32BE(offset, noAssert) {
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, 4, this.length);
    }
    return this[offset] * 16777216 + (this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3]);
  }
  readInt8(offset, noAssert) {
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, 1, this.length);
    }
    if (!(this[offset] & 128)) {
      return this[offset];
    }
    return (255 - this[offset] + 1) * -1;
  }
  readInt16LE(offset, noAssert) {
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, 2, this.length);
    }
    const val = this[offset] | this[offset + 1] << 8;
    return val & 32768 ? val | 4294901760 : val;
  }
  readInt16BE(offset, noAssert) {
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, 2, this.length);
    }
    const val = this[offset + 1] | this[offset] << 8;
    return val & 32768 ? val | 4294901760 : val;
  }
  readInt32LE(offset, noAssert) {
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, 4, this.length);
    }
    return this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16 | this[offset + 3] << 24;
  }
  readInt32BE(offset, noAssert) {
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkOffset(offset, 4, this.length);
    }
    return this[offset] << 24 | this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3];
  }
  swap16() {
    const len = this.length;
    if (len % 2 !== 0) {
      throw new RangeError("Buffer size must be a multiple of 16-bits");
    }
    for (let i = 0;i < len; i += 2) {
      this._swap(this, i, i + 1);
    }
    return this;
  }
  swap32() {
    const len = this.length;
    if (len % 4 !== 0) {
      throw new RangeError("Buffer size must be a multiple of 32-bits");
    }
    for (let i = 0;i < len; i += 4) {
      this._swap(this, i, i + 3);
      this._swap(this, i + 1, i + 2);
    }
    return this;
  }
  swap64() {
    const len = this.length;
    if (len % 8 !== 0) {
      throw new RangeError("Buffer size must be a multiple of 64-bits");
    }
    for (let i = 0;i < len; i += 8) {
      this._swap(this, i, i + 7);
      this._swap(this, i + 1, i + 6);
      this._swap(this, i + 2, i + 5);
      this._swap(this, i + 3, i + 4);
    }
    return this;
  }
  _swap(b, n, m) {
    const i = b[n];
    b[n] = b[m];
    b[m] = i;
  }
  writeUInt8(value, offset, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkInt(this, value, offset, 1, 255, 0);
    }
    this[offset] = value & 255;
    return offset + 1;
  }
  writeUInt16LE(value, offset, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkInt(this, value, offset, 2, 65535, 0);
    }
    this[offset] = value & 255;
    this[offset + 1] = value >>> 8;
    return offset + 2;
  }
  writeUInt16BE(value, offset, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkInt(this, value, offset, 2, 65535, 0);
    }
    this[offset] = value >>> 8;
    this[offset + 1] = value & 255;
    return offset + 2;
  }
  writeUInt32LE(value, offset, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkInt(this, value, offset, 4, 4294967295, 0);
    }
    this[offset + 3] = value >>> 24;
    this[offset + 2] = value >>> 16;
    this[offset + 1] = value >>> 8;
    this[offset] = value & 255;
    return offset + 4;
  }
  writeUInt32BE(value, offset, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkInt(this, value, offset, 4, 4294967295, 0);
    }
    this[offset] = value >>> 24;
    this[offset + 1] = value >>> 16;
    this[offset + 2] = value >>> 8;
    this[offset + 3] = value & 255;
    return offset + 4;
  }
  writeInt8(value, offset, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkInt(this, value, offset, 1, 127, -128);
    }
    if (value < 0) {
      value = 255 + value + 1;
    }
    this[offset] = value & 255;
    return offset + 1;
  }
  writeInt16LE(value, offset, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkInt(this, value, offset, 2, 32767, -32768);
    }
    this[offset] = value & 255;
    this[offset + 1] = value >>> 8;
    return offset + 2;
  }
  writeInt16BE(value, offset, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkInt(this, value, offset, 2, 32767, -32768);
    }
    this[offset] = value >>> 8;
    this[offset + 1] = value & 255;
    return offset + 2;
  }
  writeInt32LE(value, offset, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkInt(this, value, offset, 4, 2147483647, -2147483648);
    }
    this[offset] = value & 255;
    this[offset + 1] = value >>> 8;
    this[offset + 2] = value >>> 16;
    this[offset + 3] = value >>> 24;
    return offset + 4;
  }
  writeInt32BE(value, offset, noAssert) {
    value = +value;
    offset = offset >>> 0;
    if (!noAssert) {
      Buffer._checkInt(this, value, offset, 4, 2147483647, -2147483648);
    }
    if (value < 0) {
      value = 4294967295 + value + 1;
    }
    this[offset] = value >>> 24;
    this[offset + 1] = value >>> 16;
    this[offset + 2] = value >>> 8;
    this[offset + 3] = value & 255;
    return offset + 4;
  }
  fill(value, offset, end, encoding) {
    if (typeof value === "string") {
      if (typeof offset === "string") {
        encoding = offset;
        offset = 0;
        end = this.length;
      } else if (typeof end === "string") {
        encoding = end;
        end = this.length;
      }
      if (encoding !== undefined && typeof encoding !== "string") {
        throw new TypeError("encoding must be a string");
      }
      if (typeof encoding === "string" && !Buffer.isEncoding(encoding)) {
        throw new TypeError("Unknown encoding: " + encoding);
      }
      if (value.length === 1) {
        const code2 = value.charCodeAt(0);
        if (encoding === "utf8" && code2 < 128) {
          value = code2;
        }
      }
    } else if (typeof value === "number") {
      value = value & 255;
    } else if (typeof value === "boolean") {
      value = Number(value);
    }
    offset ?? (offset = 0);
    end ?? (end = this.length);
    if (offset < 0 || this.length < offset || this.length < end) {
      throw new RangeError("Out of range index");
    }
    if (end <= offset) {
      return this;
    }
    offset = offset >>> 0;
    end = end === undefined ? this.length : end >>> 0;
    value || (value = 0);
    let i;
    if (typeof value === "number") {
      for (i = offset;i < end; ++i) {
        this[i] = value;
      }
    } else {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
      const len = bytes.length;
      if (len === 0) {
        throw new TypeError('The value "' + value + '" is invalid for argument "value"');
      }
      for (i = 0;i < end - offset; ++i) {
        this[i + offset] = bytes[i % len];
      }
    }
    return this;
  }
  indexOf(value, byteOffset, encoding) {
    return this._bidirectionalIndexOf(this, value, byteOffset, encoding, true);
  }
  lastIndexOf(value, byteOffset, encoding) {
    return this._bidirectionalIndexOf(this, value, byteOffset, encoding, false);
  }
  _bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
    if (buffer.length === 0) {
      return -1;
    }
    if (typeof byteOffset === "string") {
      encoding = byteOffset;
      byteOffset = 0;
    } else if (typeof byteOffset === "undefined") {
      byteOffset = 0;
    } else if (byteOffset > 2147483647) {
      byteOffset = 2147483647;
    } else if (byteOffset < -2147483648) {
      byteOffset = -2147483648;
    }
    byteOffset = +byteOffset;
    if (byteOffset !== byteOffset) {
      byteOffset = dir ? 0 : buffer.length - 1;
    }
    if (byteOffset < 0) {
      byteOffset = buffer.length + byteOffset;
    }
    if (byteOffset >= buffer.length) {
      if (dir) {
        return -1;
      } else {
        byteOffset = buffer.length - 1;
      }
    } else if (byteOffset < 0) {
      if (dir) {
        byteOffset = 0;
      } else {
        return -1;
      }
    }
    if (typeof val === "string") {
      val = Buffer.from(val, encoding);
    }
    if (Buffer.isBuffer(val)) {
      if (val.length === 0) {
        return -1;
      }
      return Buffer._arrayIndexOf(buffer, val, byteOffset, encoding, dir);
    } else if (typeof val === "number") {
      val = val & 255;
      if (typeof Uint8Array.prototype.indexOf === "function") {
        if (dir) {
          return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset);
        } else {
          return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset);
        }
      }
      return Buffer._arrayIndexOf(buffer, Buffer.from([val]), byteOffset, encoding, dir);
    }
    throw new TypeError("val must be string, number or Buffer");
  }
  includes(value, byteOffset, encoding) {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  }
  static from(a, b, c) {
    return new Buffer(a, b, c);
  }
  static isBuffer(obj) {
    return obj != null && obj !== Buffer.prototype && Buffer._isInstance(obj, Buffer);
  }
  static isEncoding(encoding) {
    switch (encoding.toLowerCase()) {
      case "hex":
      case "utf8":
      case "ascii":
      case "binary":
      case "latin1":
      case "ucs2":
      case "utf16le":
      case "base64":
        return true;
      default:
        return false;
    }
  }
  static byteLength(string, encoding) {
    if (Buffer.isBuffer(string)) {
      return string.length;
    }
    if (typeof string !== "string" && (ArrayBuffer.isView(string) || Buffer._isInstance(string, ArrayBuffer))) {
      return string.byteLength;
    }
    if (typeof string !== "string") {
      throw new TypeError('The "string" argument must be one of type string, Buffer, or ArrayBuffer. Received type ' + typeof string);
    }
    const len = string.length;
    const mustMatch = arguments.length > 2 && arguments[2] === true;
    if (!mustMatch && len === 0) {
      return 0;
    }
    switch (encoding?.toLowerCase()) {
      case "ascii":
      case "latin1":
      case "binary":
        return len;
      case "utf8":
        return Buffer._utf8ToBytes(string).length;
      case "hex":
        return len >>> 1;
      case "ucs2":
      case "utf16le":
        return len * 2;
      case "base64":
        return Buffer._base64ToBytes(string).length;
      default:
        return mustMatch ? -1 : Buffer._utf8ToBytes(string).length;
    }
  }
  static concat(list, totalLength) {
    if (!Array.isArray(list)) {
      throw new TypeError('"list" argument must be an Array of Buffers');
    }
    if (list.length === 0) {
      return Buffer.alloc(0);
    }
    let i;
    if (totalLength === undefined) {
      totalLength = 0;
      for (i = 0;i < list.length; ++i) {
        totalLength += list[i].length;
      }
    }
    const buffer = Buffer.allocUnsafe(totalLength);
    let pos = 0;
    for (i = 0;i < list.length; ++i) {
      let buf = list[i];
      if (Buffer._isInstance(buf, Uint8Array)) {
        if (pos + buf.length > buffer.length) {
          if (!Buffer.isBuffer(buf)) {
            buf = Buffer.from(buf);
          }
          buf.copy(buffer, pos);
        } else {
          Uint8Array.prototype.set.call(buffer, buf, pos);
        }
      } else if (!Buffer.isBuffer(buf)) {
        throw new TypeError('"list" argument must be an Array of Buffers');
      } else {
        buf.copy(buffer, pos);
      }
      pos += buf.length;
    }
    return buffer;
  }
  static compare(buf1, buf2) {
    if (Buffer._isInstance(buf1, Uint8Array)) {
      buf1 = Buffer.from(buf1, buf1.byteOffset, buf1.byteLength);
    }
    if (Buffer._isInstance(buf2, Uint8Array)) {
      buf2 = Buffer.from(buf2, buf2.byteOffset, buf2.byteLength);
    }
    if (!Buffer.isBuffer(buf1) || !Buffer.isBuffer(buf2)) {
      throw new TypeError('The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array');
    }
    if (buf1 === buf2) {
      return 0;
    }
    let x = buf1.length;
    let y = buf2.length;
    for (let i = 0, len = Math.min(x, y);i < len; ++i) {
      if (buf1[i] !== buf2[i]) {
        x = buf1[i];
        y = buf2[i];
        break;
      }
    }
    if (x < y) {
      return -1;
    }
    if (y < x) {
      return 1;
    }
    return 0;
  }
  static alloc(size, fill, encoding) {
    if (typeof size !== "number") {
      throw new TypeError('"size" argument must be of type number');
    } else if (size < 0) {
      throw new RangeError('The value "' + size + '" is invalid for option "size"');
    }
    if (size <= 0) {
      return new Buffer(size);
    }
    if (fill !== undefined) {
      return typeof encoding === "string" ? new Buffer(size).fill(fill, 0, size, encoding) : new Buffer(size).fill(fill);
    }
    return new Buffer(size);
  }
  static allocUnsafe(size) {
    if (typeof size !== "number") {
      throw new TypeError('"size" argument must be of type number');
    } else if (size < 0) {
      throw new RangeError('The value "' + size + '" is invalid for option "size"');
    }
    return new Buffer(size < 0 ? 0 : Buffer._checked(size) | 0);
  }
  static _isInstance(obj, type) {
    return obj instanceof type || obj != null && obj.constructor != null && obj.constructor.name != null && obj.constructor.name === type.name;
  }
  static _checked(length) {
    if (length >= K_MAX_LENGTH) {
      throw new RangeError("Attempt to allocate Buffer larger than maximum size: 0x" + K_MAX_LENGTH.toString(16) + " bytes");
    }
    return length | 0;
  }
  static _blitBuffer(src, dst, offset, length) {
    let i;
    for (i = 0;i < length; ++i) {
      if (i + offset >= dst.length || i >= src.length) {
        break;
      }
      dst[i + offset] = src[i];
    }
    return i;
  }
  static _utf8Write(buf, string, offset, length) {
    return Buffer._blitBuffer(Buffer._utf8ToBytes(string, buf.length - offset), buf, offset, length);
  }
  static _asciiWrite(buf, string, offset, length) {
    return Buffer._blitBuffer(Buffer._asciiToBytes(string), buf, offset, length);
  }
  static _base64Write(buf, string, offset, length) {
    return Buffer._blitBuffer(Buffer._base64ToBytes(string), buf, offset, length);
  }
  static _ucs2Write(buf, string, offset, length) {
    return Buffer._blitBuffer(Buffer._utf16leToBytes(string, buf.length - offset), buf, offset, length);
  }
  static _hexWrite(buf, string, offset, length) {
    offset = Number(offset) || 0;
    const remaining = buf.length - offset;
    if (!length) {
      length = remaining;
    } else {
      length = Number(length);
      if (length > remaining) {
        length = remaining;
      }
    }
    const strLen = string.length;
    if (length > strLen / 2) {
      length = strLen / 2;
    }
    let i;
    for (i = 0;i < length; ++i) {
      const parsed = parseInt(string.substr(i * 2, 2), 16);
      if (parsed !== parsed) {
        return i;
      }
      buf[offset + i] = parsed;
    }
    return i;
  }
  static _utf8ToBytes(string, units) {
    units = units || Infinity;
    const length = string.length;
    const bytes = [];
    let codePoint;
    let leadSurrogate = null;
    for (let i = 0;i < length; ++i) {
      codePoint = string.charCodeAt(i);
      if (codePoint > 55295 && codePoint < 57344) {
        if (!leadSurrogate) {
          if (codePoint > 56319) {
            if ((units -= 3) > -1) {
              bytes.push(239, 191, 189);
            }
            continue;
          } else if (i + 1 === length) {
            if ((units -= 3) > -1) {
              bytes.push(239, 191, 189);
            }
            continue;
          }
          leadSurrogate = codePoint;
          continue;
        }
        if (codePoint < 56320) {
          if ((units -= 3) > -1) {
            bytes.push(239, 191, 189);
          }
          leadSurrogate = codePoint;
          continue;
        }
        codePoint = (leadSurrogate - 55296 << 10 | codePoint - 56320) + 65536;
      } else if (leadSurrogate) {
        if ((units -= 3) > -1) {
          bytes.push(239, 191, 189);
        }
      }
      leadSurrogate = null;
      if (codePoint < 128) {
        if ((units -= 1) < 0) {
          break;
        }
        bytes.push(codePoint);
      } else if (codePoint < 2048) {
        if ((units -= 2) < 0) {
          break;
        }
        bytes.push(codePoint >> 6 | 192, codePoint & 63 | 128);
      } else if (codePoint < 65536) {
        if ((units -= 3) < 0) {
          break;
        }
        bytes.push(codePoint >> 12 | 224, codePoint >> 6 & 63 | 128, codePoint & 63 | 128);
      } else if (codePoint < 1114112) {
        if ((units -= 4) < 0) {
          break;
        }
        bytes.push(codePoint >> 18 | 240, codePoint >> 12 & 63 | 128, codePoint >> 6 & 63 | 128, codePoint & 63 | 128);
      } else {
        throw new Error("Invalid code point");
      }
    }
    return bytes;
  }
  static _base64ToBytes(str) {
    return toByteArray(base64clean(str));
  }
  static _asciiToBytes(str) {
    const byteArray = [];
    for (let i = 0;i < str.length; ++i) {
      byteArray.push(str.charCodeAt(i) & 255);
    }
    return byteArray;
  }
  static _utf16leToBytes(str, units) {
    let c, hi, lo;
    const byteArray = [];
    for (let i = 0;i < str.length; ++i) {
      if ((units -= 2) < 0)
        break;
      c = str.charCodeAt(i);
      hi = c >> 8;
      lo = c % 256;
      byteArray.push(lo);
      byteArray.push(hi);
    }
    return byteArray;
  }
  static _hexSlice(buf, start, end) {
    const len = buf.length;
    if (!start || start < 0) {
      start = 0;
    }
    if (!end || end < 0 || end > len) {
      end = len;
    }
    let out = "";
    for (let i = start;i < end; ++i) {
      out += hexSliceLookupTable[buf[i]];
    }
    return out;
  }
  static _base64Slice(buf, start, end) {
    if (start === 0 && end === buf.length) {
      return fromByteArray(buf);
    } else {
      return fromByteArray(buf.slice(start, end));
    }
  }
  static _utf8Slice(buf, start, end) {
    end = Math.min(buf.length, end);
    const res = [];
    let i = start;
    while (i < end) {
      const firstByte = buf[i];
      let codePoint = null;
      let bytesPerSequence = firstByte > 239 ? 4 : firstByte > 223 ? 3 : firstByte > 191 ? 2 : 1;
      if (i + bytesPerSequence <= end) {
        let secondByte, thirdByte, fourthByte, tempCodePoint;
        switch (bytesPerSequence) {
          case 1:
            if (firstByte < 128) {
              codePoint = firstByte;
            }
            break;
          case 2:
            secondByte = buf[i + 1];
            if ((secondByte & 192) === 128) {
              tempCodePoint = (firstByte & 31) << 6 | secondByte & 63;
              if (tempCodePoint > 127) {
                codePoint = tempCodePoint;
              }
            }
            break;
          case 3:
            secondByte = buf[i + 1];
            thirdByte = buf[i + 2];
            if ((secondByte & 192) === 128 && (thirdByte & 192) === 128) {
              tempCodePoint = (firstByte & 15) << 12 | (secondByte & 63) << 6 | thirdByte & 63;
              if (tempCodePoint > 2047 && (tempCodePoint < 55296 || tempCodePoint > 57343)) {
                codePoint = tempCodePoint;
              }
            }
            break;
          case 4:
            secondByte = buf[i + 1];
            thirdByte = buf[i + 2];
            fourthByte = buf[i + 3];
            if ((secondByte & 192) === 128 && (thirdByte & 192) === 128 && (fourthByte & 192) === 128) {
              tempCodePoint = (firstByte & 15) << 18 | (secondByte & 63) << 12 | (thirdByte & 63) << 6 | fourthByte & 63;
              if (tempCodePoint > 65535 && tempCodePoint < 1114112) {
                codePoint = tempCodePoint;
              }
            }
        }
      }
      if (codePoint === null) {
        codePoint = 65533;
        bytesPerSequence = 1;
      } else if (codePoint > 65535) {
        codePoint -= 65536;
        res.push(codePoint >>> 10 & 1023 | 55296);
        codePoint = 56320 | codePoint & 1023;
      }
      res.push(codePoint);
      i += bytesPerSequence;
    }
    return Buffer._decodeCodePointsArray(res);
  }
  static _decodeCodePointsArray(codePoints) {
    const len = codePoints.length;
    if (len <= MAX_ARGUMENTS_LENGTH) {
      return String.fromCharCode.apply(String, codePoints);
    }
    let res = "";
    let i = 0;
    while (i < len) {
      res += String.fromCharCode.apply(String, codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH));
    }
    return res;
  }
  static _asciiSlice(buf, start, end) {
    let ret = "";
    end = Math.min(buf.length, end);
    for (let i = start;i < end; ++i) {
      ret += String.fromCharCode(buf[i] & 127);
    }
    return ret;
  }
  static _latin1Slice(buf, start, end) {
    let ret = "";
    end = Math.min(buf.length, end);
    for (let i = start;i < end; ++i) {
      ret += String.fromCharCode(buf[i]);
    }
    return ret;
  }
  static _utf16leSlice(buf, start, end) {
    const bytes = buf.slice(start, end);
    let res = "";
    for (let i = 0;i < bytes.length - 1; i += 2) {
      res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
    }
    return res;
  }
  static _arrayIndexOf(arr, val, byteOffset, encoding, dir) {
    let indexSize = 1;
    let arrLength = arr.length;
    let valLength = val.length;
    if (encoding !== undefined) {
      encoding = Buffer._getEncoding(encoding);
      if (encoding === "ucs2" || encoding === "utf16le") {
        if (arr.length < 2 || val.length < 2) {
          return -1;
        }
        indexSize = 2;
        arrLength /= 2;
        valLength /= 2;
        byteOffset /= 2;
      }
    }
    function read(buf, i2) {
      if (indexSize === 1) {
        return buf[i2];
      } else {
        return buf.readUInt16BE(i2 * indexSize);
      }
    }
    let i;
    if (dir) {
      let foundIndex = -1;
      for (i = byteOffset;i < arrLength; i++) {
        if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
          if (foundIndex === -1)
            foundIndex = i;
          if (i - foundIndex + 1 === valLength)
            return foundIndex * indexSize;
        } else {
          if (foundIndex !== -1)
            i -= i - foundIndex;
          foundIndex = -1;
        }
      }
    } else {
      if (byteOffset + valLength > arrLength) {
        byteOffset = arrLength - valLength;
      }
      for (i = byteOffset;i >= 0; i--) {
        let found = true;
        for (let j = 0;j < valLength; j++) {
          if (read(arr, i + j) !== read(val, j)) {
            found = false;
            break;
          }
        }
        if (found) {
          return i;
        }
      }
    }
    return -1;
  }
  static _checkOffset(offset, ext, length) {
    if (offset % 1 !== 0 || offset < 0)
      throw new RangeError("offset is not uint");
    if (offset + ext > length)
      throw new RangeError("Trying to access beyond buffer length");
  }
  static _checkInt(buf, value, offset, ext, max, min) {
    if (!Buffer.isBuffer(buf))
      throw new TypeError('"buffer" argument must be a Buffer instance');
    if (value > max || value < min)
      throw new RangeError('"value" argument is out of bounds');
    if (offset + ext > buf.length)
      throw new RangeError("Index out of range");
  }
  static _getEncoding(encoding) {
    let toLowerCase = false;
    let originalEncoding = "";
    for (;; ) {
      switch (encoding) {
        case "hex":
          return "hex";
        case "utf8":
          return "utf8";
        case "ascii":
          return "ascii";
        case "binary":
          return "binary";
        case "latin1":
          return "latin1";
        case "ucs2":
          return "ucs2";
        case "utf16le":
          return "utf16le";
        case "base64":
          return "base64";
        default: {
          if (toLowerCase) {
            throw new TypeError("Unknown or unsupported encoding: " + originalEncoding);
          }
          toLowerCase = true;
          originalEncoding = encoding;
          encoding = encoding.toLowerCase();
        }
      }
    }
  }
}
var hexSliceLookupTable = function() {
  const alphabet = "0123456789abcdef";
  const table = new Array(256);
  for (let i = 0;i < 16; ++i) {
    const i16 = i * 16;
    for (let j = 0;j < 16; ++j) {
      table[i16 + j] = alphabet[i] + alphabet[j];
    }
  }
  return table;
}();
var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;
var __typeError$8 = (msg) => {
  throw TypeError(msg);
};
var __accessCheck$8 = (obj, member, msg) => member.has(obj) || __typeError$8("Cannot " + msg);
var __privateGet$7 = (obj, member, getter) => (__accessCheck$8(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd$8 = (obj, member, value) => member.has(obj) ? __typeError$8("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet$6 = (obj, member, value, setter) => (__accessCheck$8(obj, member, "write to private field"), member.set(obj, value), value);
var __privateMethod$4 = (obj, member, method) => (__accessCheck$8(obj, member, "access private method"), method);
var _fetch;
var _queue;
var _concurrency;
var _ApiRequestPool_instances;
var enqueue_fn;
var REQUEST_TIMEOUT = 5 * 60 * 1000;

class ApiRequestPool {
  constructor(concurrency = 10) {
    __privateAdd$8(this, _ApiRequestPool_instances);
    __privateAdd$8(this, _fetch);
    __privateAdd$8(this, _queue);
    __privateAdd$8(this, _concurrency);
    __privateSet$6(this, _queue, []);
    __privateSet$6(this, _concurrency, concurrency);
    this.running = 0;
    this.started = 0;
  }
  setFetch(fetch2) {
    __privateSet$6(this, _fetch, fetch2);
  }
  getFetch() {
    if (!__privateGet$7(this, _fetch)) {
      throw new Error("Fetch not set");
    }
    return __privateGet$7(this, _fetch);
  }
  request(url6, options) {
    const start = new Date;
    const fetchImpl = this.getFetch();
    const runRequest = async (stalled = false) => {
      const { promise, cancel } = timeoutWithCancel(REQUEST_TIMEOUT);
      const response = await Promise.race([fetchImpl(url6, options), promise.then(() => null)]).finally(cancel);
      if (!response) {
        throw new Error("Request timed out");
      }
      if (response.status === 429) {
        const rateLimitReset = parseNumber(response.headers?.get("x-ratelimit-reset")) ?? 1;
        await timeout(rateLimitReset * 1000);
        return await runRequest(true);
      }
      if (stalled) {
        const stalledTime = (new Date()).getTime() - start.getTime();
        console.warn(`A request to Xata hit branch rate limits, was retried and stalled for ${stalledTime}ms`);
      }
      return response;
    };
    return __privateMethod$4(this, _ApiRequestPool_instances, enqueue_fn).call(this, async () => {
      return await runRequest();
    });
  }
}
_fetch = new WeakMap;
_queue = new WeakMap;
_concurrency = new WeakMap;
_ApiRequestPool_instances = new WeakSet;
enqueue_fn = function(task) {
  const promise = new Promise((resolve) => __privateGet$7(this, _queue).push(resolve)).finally(() => {
    this.started--;
    this.running++;
  }).then(() => task()).finally(() => {
    this.running--;
    const next = __privateGet$7(this, _queue).shift();
    if (next !== undefined) {
      this.started++;
      next();
    }
  });
  if (this.running + this.started < __privateGet$7(this, _concurrency)) {
    const next = __privateGet$7(this, _queue).shift();
    if (next !== undefined) {
      this.started++;
      next();
    }
  }
  return promise;
};
var EventStreamContentType = "text/event-stream";
var LastEventId = "last-event-id";
var VERSION = "0.29.5";

class ErrorWithCause extends Error {
  constructor(message, options) {
    super(message, options);
  }
}

class FetcherError extends ErrorWithCause {
  constructor(status, data, requestId) {
    super(getMessage(data));
    this.status = status;
    this.errors = isBulkError(data) ? data.errors : [{ message: getMessage(data), status }];
    this.requestId = requestId;
    if (data instanceof Error) {
      this.stack = data.stack;
      this.cause = data.cause;
    }
  }
  toString() {
    const error = super.toString();
    return `[${this.status}] (${this.requestId ?? "Unknown"}): ${error}`;
  }
}
var providers = {
  production: {
    main: "https://api.xata.io",
    workspaces: "https://{workspaceId}.{region}.xata.sh"
  },
  staging: {
    main: "https://api.staging-xata.dev",
    workspaces: "https://{workspaceId}.{region}.staging-xata.dev"
  },
  dev: {
    main: "https://api.dev-xata.dev",
    workspaces: "https://{workspaceId}.{region}.dev-xata.dev"
  },
  local: {
    main: "http://localhost:6001",
    workspaces: "http://{workspaceId}.{region}.localhost:6001"
  }
};
var pool = new ApiRequestPool;
var resolveUrl = (url6, queryParams = {}, pathParams = {}) => {
  const cleanQueryParams = Object.entries(queryParams).reduce((acc, [key, value]) => {
    if (value === undefined || value === null)
      return acc;
    return { ...acc, [key]: value };
  }, {});
  const query = new URLSearchParams(cleanQueryParams).toString();
  const queryString = query.length > 0 ? `?${query}` : "";
  const cleanPathParams = Object.entries(pathParams).reduce((acc, [key, value]) => {
    return { ...acc, [key]: encodeURIComponent(String(value ?? "")).replace("%3A", ":") };
  }, {});
  return url6.replace(/\{\w*\}/g, (key) => cleanPathParams[key.slice(1, -1)]) + queryString;
};
var defaultClientID = generateUUID();
var dataPlaneFetch = async (options) => fetch$1({ ...options, endpoint: "dataPlane" });
var applyMigration = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/apply",
  method: "post",
  ...variables,
  signal
});
var startMigration = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/start",
  method: "post",
  ...variables,
  signal
});
var completeMigration = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/complete",
  method: "post",
  ...variables,
  signal
});
var rollbackMigration = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/rollback",
  method: "post",
  ...variables,
  signal
});
var adaptTable = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/adapt/{tableName}",
  method: "post",
  ...variables,
  signal
});
var adaptAllTables = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/adapt",
  method: "post",
  ...variables,
  signal
});
var getBranchMigrationJobStatus = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/status",
  method: "get",
  ...variables,
  signal
});
var getMigrationJobStatus = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/jobs/{jobId}",
  method: "get",
  ...variables,
  signal
});
var getMigrationHistory = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/history",
  method: "get",
  ...variables,
  signal
});
var getBranchList = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}",
  method: "get",
  ...variables,
  signal
});
var getDatabaseSettings = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}/settings",
  method: "get",
  ...variables,
  signal
});
var updateDatabaseSettings = (variables, signal) => dataPlaneFetch({ url: "/dbs/{dbName}/settings", method: "patch", ...variables, signal });
var getBranchDetails = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}",
  method: "get",
  ...variables,
  signal
});
var createBranch = (variables, signal) => dataPlaneFetch({ url: "/db/{dbBranchName}", method: "put", ...variables, signal });
var deleteBranch = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}",
  method: "delete",
  ...variables,
  signal
});
var getSchema = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/schema",
  method: "get",
  ...variables,
  signal
});
var copyBranch = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/copy",
  method: "post",
  ...variables,
  signal
});
var updateBranchMetadata = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/metadata",
  method: "put",
  ...variables,
  signal
});
var getBranchMetadata = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/metadata",
  method: "get",
  ...variables,
  signal
});
var getBranchStats = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/stats",
  method: "get",
  ...variables,
  signal
});
var getGitBranchesMapping = (variables, signal) => dataPlaneFetch({ url: "/dbs/{dbName}/gitBranches", method: "get", ...variables, signal });
var addGitBranchesEntry = (variables, signal) => dataPlaneFetch({ url: "/dbs/{dbName}/gitBranches", method: "post", ...variables, signal });
var removeGitBranchesEntry = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}/gitBranches",
  method: "delete",
  ...variables,
  signal
});
var resolveBranch = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}/resolveBranch",
  method: "get",
  ...variables,
  signal
});
var getBranchMigrationHistory = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations",
  method: "get",
  ...variables,
  signal
});
var getBranchMigrationPlan = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/plan",
  method: "post",
  ...variables,
  signal
});
var executeBranchMigrationPlan = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/migrations/execute",
  method: "post",
  ...variables,
  signal
});
var queryMigrationRequests = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}/migrations/query",
  method: "post",
  ...variables,
  signal
});
var createMigrationRequest = (variables, signal) => dataPlaneFetch({ url: "/dbs/{dbName}/migrations", method: "post", ...variables, signal });
var getMigrationRequest = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}/migrations/{mrNumber}",
  method: "get",
  ...variables,
  signal
});
var updateMigrationRequest = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}/migrations/{mrNumber}",
  method: "patch",
  ...variables,
  signal
});
var listMigrationRequestsCommits = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}/migrations/{mrNumber}/commits",
  method: "post",
  ...variables,
  signal
});
var compareMigrationRequest = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}/migrations/{mrNumber}/compare",
  method: "post",
  ...variables,
  signal
});
var getMigrationRequestIsMerged = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}/migrations/{mrNumber}/merge",
  method: "get",
  ...variables,
  signal
});
var mergeMigrationRequest = (variables, signal) => dataPlaneFetch({
  url: "/dbs/{dbName}/migrations/{mrNumber}/merge",
  method: "post",
  ...variables,
  signal
});
var getBranchSchemaHistory = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/schema/history",
  method: "post",
  ...variables,
  signal
});
var compareBranchWithUserSchema = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/schema/compare",
  method: "post",
  ...variables,
  signal
});
var compareBranchSchemas = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/schema/compare/{branchName}",
  method: "post",
  ...variables,
  signal
});
var updateBranchSchema = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/schema/update",
  method: "post",
  ...variables,
  signal
});
var previewBranchSchemaEdit = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/schema/preview",
  method: "post",
  ...variables,
  signal
});
var applyBranchSchemaEdit = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/schema/apply",
  method: "post",
  ...variables,
  signal
});
var pushBranchMigrations = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/schema/push",
  method: "post",
  ...variables,
  signal
});
var createTable = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}",
  method: "put",
  ...variables,
  signal
});
var deleteTable = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}",
  method: "delete",
  ...variables,
  signal
});
var updateTable = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}",
  method: "patch",
  ...variables,
  signal
});
var getTableSchema = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/schema",
  method: "get",
  ...variables,
  signal
});
var setTableSchema = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/schema",
  method: "put",
  ...variables,
  signal
});
var getTableColumns = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/columns",
  method: "get",
  ...variables,
  signal
});
var addTableColumn = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/columns",
  method: "post",
  ...variables,
  signal
});
var getColumn = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/columns/{columnName}",
  method: "get",
  ...variables,
  signal
});
var updateColumn = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/columns/{columnName}",
  method: "patch",
  ...variables,
  signal
});
var deleteColumn = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/columns/{columnName}",
  method: "delete",
  ...variables,
  signal
});
var branchTransaction = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/transaction",
  method: "post",
  ...variables,
  signal
});
var insertRecord = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data",
  method: "post",
  ...variables,
  signal
});
var getFileItem = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}/column/{columnName}/file/{fileId}",
  method: "get",
  ...variables,
  signal
});
var putFileItem = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}/column/{columnName}/file/{fileId}",
  method: "put",
  ...variables,
  signal
});
var deleteFileItem = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}/column/{columnName}/file/{fileId}",
  method: "delete",
  ...variables,
  signal
});
var getFile = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}/column/{columnName}/file",
  method: "get",
  ...variables,
  signal
});
var putFile = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}/column/{columnName}/file",
  method: "put",
  ...variables,
  signal
});
var deleteFile = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}/column/{columnName}/file",
  method: "delete",
  ...variables,
  signal
});
var getRecord = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}",
  method: "get",
  ...variables,
  signal
});
var insertRecordWithID = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}",
  method: "put",
  ...variables,
  signal
});
var updateRecordWithID = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}",
  method: "patch",
  ...variables,
  signal
});
var upsertRecordWithID = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}",
  method: "post",
  ...variables,
  signal
});
var deleteRecord = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/data/{recordId}",
  method: "delete",
  ...variables,
  signal
});
var bulkInsertTableRecords = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/bulk",
  method: "post",
  ...variables,
  signal
});
var queryTable = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/query",
  method: "post",
  ...variables,
  signal
});
var searchBranch = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/search",
  method: "post",
  ...variables,
  signal
});
var searchTable = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/search",
  method: "post",
  ...variables,
  signal
});
var vectorSearchTable = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/vectorSearch",
  method: "post",
  ...variables,
  signal
});
var askTable = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/ask",
  method: "post",
  ...variables,
  signal
});
var askTableSession = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/ask/{sessionId}",
  method: "post",
  ...variables,
  signal
});
var summarizeTable = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/summarize",
  method: "post",
  ...variables,
  signal
});
var aggregateTable = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/tables/{tableName}/aggregate",
  method: "post",
  ...variables,
  signal
});
var fileAccess = (variables, signal) => dataPlaneFetch({
  url: "/file/{fileId}",
  method: "get",
  ...variables,
  signal
});
var fileUpload = (variables, signal) => dataPlaneFetch({
  url: "/file/{fileId}",
  method: "put",
  ...variables,
  signal
});
var sqlQuery = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/sql",
  method: "post",
  ...variables,
  signal
});
var sqlBatchQuery = (variables, signal) => dataPlaneFetch({
  url: "/db/{dbBranchName}/sql/batch",
  method: "post",
  ...variables,
  signal
});
var operationsByTag$2 = {
  migrations: {
    applyMigration,
    startMigration,
    completeMigration,
    rollbackMigration,
    adaptTable,
    adaptAllTables,
    getBranchMigrationJobStatus,
    getMigrationJobStatus,
    getMigrationHistory,
    getSchema,
    getBranchMigrationHistory,
    getBranchMigrationPlan,
    executeBranchMigrationPlan,
    getBranchSchemaHistory,
    compareBranchWithUserSchema,
    compareBranchSchemas,
    updateBranchSchema,
    previewBranchSchemaEdit,
    applyBranchSchemaEdit,
    pushBranchMigrations
  },
  branch: {
    getBranchList,
    getBranchDetails,
    createBranch,
    deleteBranch,
    copyBranch,
    updateBranchMetadata,
    getBranchMetadata,
    getBranchStats,
    getGitBranchesMapping,
    addGitBranchesEntry,
    removeGitBranchesEntry,
    resolveBranch
  },
  database: { getDatabaseSettings, updateDatabaseSettings },
  migrationRequests: {
    queryMigrationRequests,
    createMigrationRequest,
    getMigrationRequest,
    updateMigrationRequest,
    listMigrationRequestsCommits,
    compareMigrationRequest,
    getMigrationRequestIsMerged,
    mergeMigrationRequest
  },
  table: {
    createTable,
    deleteTable,
    updateTable,
    getTableSchema,
    setTableSchema,
    getTableColumns,
    addTableColumn,
    getColumn,
    updateColumn,
    deleteColumn
  },
  records: {
    branchTransaction,
    insertRecord,
    getRecord,
    insertRecordWithID,
    updateRecordWithID,
    upsertRecordWithID,
    deleteRecord,
    bulkInsertTableRecords
  },
  files: {
    getFileItem,
    putFileItem,
    deleteFileItem,
    getFile,
    putFile,
    deleteFile,
    fileAccess,
    fileUpload
  },
  searchAndFilter: {
    queryTable,
    searchBranch,
    searchTable,
    vectorSearchTable,
    askTable,
    askTableSession,
    summarizeTable,
    aggregateTable
  },
  sql: { sqlQuery, sqlBatchQuery }
};
var controlPlaneFetch = async (options) => fetch$1({ ...options, endpoint: "controlPlane" });
var getAuthorizationCode = (variables, signal) => controlPlaneFetch({ url: "/oauth/authorize", method: "get", ...variables, signal });
var grantAuthorizationCode = (variables, signal) => controlPlaneFetch({ url: "/oauth/authorize", method: "post", ...variables, signal });
var getUser = (variables, signal) => controlPlaneFetch({
  url: "/user",
  method: "get",
  ...variables,
  signal
});
var updateUser = (variables, signal) => controlPlaneFetch({
  url: "/user",
  method: "put",
  ...variables,
  signal
});
var deleteUser = (variables, signal) => controlPlaneFetch({
  url: "/user",
  method: "delete",
  ...variables,
  signal
});
var getUserAPIKeys = (variables, signal) => controlPlaneFetch({
  url: "/user/keys",
  method: "get",
  ...variables,
  signal
});
var createUserAPIKey = (variables, signal) => controlPlaneFetch({
  url: "/user/keys/{keyName}",
  method: "post",
  ...variables,
  signal
});
var deleteUserAPIKey = (variables, signal) => controlPlaneFetch({
  url: "/user/keys/{keyName}",
  method: "delete",
  ...variables,
  signal
});
var getUserOAuthClients = (variables, signal) => controlPlaneFetch({
  url: "/user/oauth/clients",
  method: "get",
  ...variables,
  signal
});
var deleteUserOAuthClient = (variables, signal) => controlPlaneFetch({
  url: "/user/oauth/clients/{clientId}",
  method: "delete",
  ...variables,
  signal
});
var getUserOAuthAccessTokens = (variables, signal) => controlPlaneFetch({
  url: "/user/oauth/tokens",
  method: "get",
  ...variables,
  signal
});
var deleteOAuthAccessToken = (variables, signal) => controlPlaneFetch({
  url: "/user/oauth/tokens/{token}",
  method: "delete",
  ...variables,
  signal
});
var updateOAuthAccessToken = (variables, signal) => controlPlaneFetch({
  url: "/user/oauth/tokens/{token}",
  method: "patch",
  ...variables,
  signal
});
var getWorkspacesList = (variables, signal) => controlPlaneFetch({
  url: "/workspaces",
  method: "get",
  ...variables,
  signal
});
var createWorkspace = (variables, signal) => controlPlaneFetch({
  url: "/workspaces",
  method: "post",
  ...variables,
  signal
});
var getWorkspace = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}",
  method: "get",
  ...variables,
  signal
});
var updateWorkspace = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}",
  method: "put",
  ...variables,
  signal
});
var deleteWorkspace = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}",
  method: "delete",
  ...variables,
  signal
});
var getWorkspaceSettings = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/settings",
  method: "get",
  ...variables,
  signal
});
var updateWorkspaceSettings = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/settings",
  method: "patch",
  ...variables,
  signal
});
var getWorkspaceMembersList = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/members",
  method: "get",
  ...variables,
  signal
});
var updateWorkspaceMemberRole = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/members/{userId}",
  method: "put",
  ...variables,
  signal
});
var removeWorkspaceMember = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/members/{userId}",
  method: "delete",
  ...variables,
  signal
});
var inviteWorkspaceMember = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/invites",
  method: "post",
  ...variables,
  signal
});
var updateWorkspaceMemberInvite = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/invites/{inviteId}",
  method: "patch",
  ...variables,
  signal
});
var cancelWorkspaceMemberInvite = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/invites/{inviteId}",
  method: "delete",
  ...variables,
  signal
});
var acceptWorkspaceMemberInvite = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/invites/{inviteKey}/accept",
  method: "post",
  ...variables,
  signal
});
var resendWorkspaceMemberInvite = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/invites/{inviteId}/resend",
  method: "post",
  ...variables,
  signal
});
var listClusters = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/clusters",
  method: "get",
  ...variables,
  signal
});
var createCluster = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/clusters",
  method: "post",
  ...variables,
  signal
});
var getCluster = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/clusters/{clusterId}",
  method: "get",
  ...variables,
  signal
});
var updateCluster = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/clusters/{clusterId}",
  method: "patch",
  ...variables,
  signal
});
var deleteCluster = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/clusters/{clusterId}",
  method: "delete",
  ...variables,
  signal
});
var getDatabaseList = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/dbs",
  method: "get",
  ...variables,
  signal
});
var createDatabase = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/dbs/{dbName}",
  method: "put",
  ...variables,
  signal
});
var deleteDatabase = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/dbs/{dbName}",
  method: "delete",
  ...variables,
  signal
});
var getDatabaseMetadata = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/dbs/{dbName}",
  method: "get",
  ...variables,
  signal
});
var updateDatabaseMetadata = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/dbs/{dbName}",
  method: "patch",
  ...variables,
  signal
});
var renameDatabase = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/dbs/{dbName}/rename",
  method: "post",
  ...variables,
  signal
});
var getDatabaseGithubSettings = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/dbs/{dbName}/github",
  method: "get",
  ...variables,
  signal
});
var updateDatabaseGithubSettings = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/dbs/{dbName}/github",
  method: "put",
  ...variables,
  signal
});
var deleteDatabaseGithubSettings = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/dbs/{dbName}/github",
  method: "delete",
  ...variables,
  signal
});
var listRegions = (variables, signal) => controlPlaneFetch({
  url: "/workspaces/{workspaceId}/regions",
  method: "get",
  ...variables,
  signal
});
var operationsByTag$1 = {
  oAuth: {
    getAuthorizationCode,
    grantAuthorizationCode,
    getUserOAuthClients,
    deleteUserOAuthClient,
    getUserOAuthAccessTokens,
    deleteOAuthAccessToken,
    updateOAuthAccessToken
  },
  users: { getUser, updateUser, deleteUser },
  authentication: { getUserAPIKeys, createUserAPIKey, deleteUserAPIKey },
  workspaces: {
    getWorkspacesList,
    createWorkspace,
    getWorkspace,
    updateWorkspace,
    deleteWorkspace,
    getWorkspaceSettings,
    updateWorkspaceSettings,
    getWorkspaceMembersList,
    updateWorkspaceMemberRole,
    removeWorkspaceMember
  },
  invites: {
    inviteWorkspaceMember,
    updateWorkspaceMemberInvite,
    cancelWorkspaceMemberInvite,
    acceptWorkspaceMemberInvite,
    resendWorkspaceMemberInvite
  },
  xbcontrolOther: {
    listClusters,
    createCluster,
    getCluster,
    updateCluster,
    deleteCluster
  },
  databases: {
    getDatabaseList,
    createDatabase,
    deleteDatabase,
    getDatabaseMetadata,
    updateDatabaseMetadata,
    renameDatabase,
    getDatabaseGithubSettings,
    updateDatabaseGithubSettings,
    deleteDatabaseGithubSettings,
    listRegions
  }
};
var operationsByTag = deepMerge(operationsByTag$2, operationsByTag$1);
var _extraProps;
var _namespaces;
_extraProps = new WeakMap;
_namespaces = new WeakMap;
class XataPlugin {
}

class XataFile {
  constructor(file) {
    this.id = file.id;
    this.name = file.name;
    this.mediaType = file.mediaType;
    this.base64Content = file.base64Content;
    this.enablePublicUrl = file.enablePublicUrl;
    this.signedUrlTimeout = file.signedUrlTimeout;
    this.uploadUrlTimeout = file.uploadUrlTimeout;
    this.size = file.size;
    this.version = file.version;
    this.url = file.url;
    this.signedUrl = file.signedUrl;
    this.uploadUrl = file.uploadUrl;
    this.attributes = file.attributes;
  }
  static fromBuffer(buffer, options = {}) {
    const base64Content = buffer.toString("base64");
    return new XataFile({ ...options, base64Content });
  }
  toBuffer() {
    if (!this.base64Content) {
      throw new Error(`File content is not available, please select property "base64Content" when querying the file`);
    }
    return Buffer.from(this.base64Content, "base64");
  }
  static fromArrayBuffer(arrayBuffer, options = {}) {
    const uint8Array = new Uint8Array(arrayBuffer);
    return this.fromUint8Array(uint8Array, options);
  }
  toArrayBuffer() {
    if (!this.base64Content) {
      throw new Error(`File content is not available, please select property "base64Content" when querying the file`);
    }
    const binary = atob(this.base64Content);
    return new ArrayBuffer(binary.length);
  }
  static fromUint8Array(uint8Array, options = {}) {
    let binary = "";
    for (let i = 0;i < uint8Array.byteLength; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64Content = btoa(binary);
    return new XataFile({ ...options, base64Content });
  }
  toUint8Array() {
    if (!this.base64Content) {
      throw new Error(`File content is not available, please select property "base64Content" when querying the file`);
    }
    const binary = atob(this.base64Content);
    const uint8Array = new Uint8Array(binary.length);
    for (let i = 0;i < binary.length; i++) {
      uint8Array[i] = binary.charCodeAt(i);
    }
    return uint8Array;
  }
  static async fromBlob(file, options = {}) {
    const name = options.name ?? file.name;
    const mediaType = file.type;
    const arrayBuffer = await file.arrayBuffer();
    return this.fromArrayBuffer(arrayBuffer, { ...options, name, mediaType });
  }
  toBlob() {
    if (!this.base64Content) {
      throw new Error(`File content is not available, please select property "base64Content" when querying the file`);
    }
    const binary = atob(this.base64Content);
    const uint8Array = new Uint8Array(binary.length);
    for (let i = 0;i < binary.length; i++) {
      uint8Array[i] = binary.charCodeAt(i);
    }
    return new Blob([uint8Array], { type: this.mediaType });
  }
  static fromString(string, options = {}) {
    const base64Content = btoa(string);
    return new XataFile({ ...options, base64Content });
  }
  toString() {
    if (!this.base64Content) {
      throw new Error(`File content is not available, please select property "base64Content" when querying the file`);
    }
    return atob(this.base64Content);
  }
  static fromBase64(base64Content, options = {}) {
    return new XataFile({ ...options, base64Content });
  }
  toBase64() {
    if (!this.base64Content) {
      throw new Error(`File content is not available, please select property "base64Content" when querying the file`);
    }
    return this.base64Content;
  }
  transform(...options) {
    return {
      url: transformImage(this.url, ...options),
      signedUrl: transformImage(this.signedUrl, ...options),
      metadataUrl: transformImage(this.url, ...options, { format: "json" }),
      metadataSignedUrl: transformImage(this.signedUrl, ...options, { format: "json" })
    };
  }
}
var parseInputFileEntry = async (entry) => {
  if (!isDefined(entry))
    return null;
  const { id, name, mediaType, base64Content, enablePublicUrl, signedUrlTimeout, uploadUrlTimeout } = await entry;
  return compactObject({
    id,
    name: name ? name : undefined,
    mediaType,
    base64Content,
    enablePublicUrl,
    signedUrlTimeout,
    uploadUrlTimeout
  });
};
var __typeError$6 = (msg) => {
  throw TypeError(msg);
};
var __accessCheck$6 = (obj, member, msg) => member.has(obj) || __typeError$6("Cannot " + msg);
var __privateGet$5 = (obj, member, getter) => (__accessCheck$6(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd$6 = (obj, member, value) => member.has(obj) ? __typeError$6("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet$4 = (obj, member, value, setter) => (__accessCheck$6(obj, member, "write to private field"), member.set(obj, value), value);
var _query;
var _page;

class Page {
  constructor(query, meta, records = []) {
    __privateAdd$6(this, _query);
    __privateSet$4(this, _query, query);
    this.meta = meta;
    this.records = new PageRecordArray(this, records);
  }
  async nextPage(size, offset) {
    return __privateGet$5(this, _query).getPaginated({ pagination: { size, offset, after: this.meta.page.cursor } });
  }
  async previousPage(size, offset) {
    return __privateGet$5(this, _query).getPaginated({ pagination: { size, offset, before: this.meta.page.cursor } });
  }
  async startPage(size, offset) {
    return __privateGet$5(this, _query).getPaginated({ pagination: { size, offset, start: this.meta.page.cursor } });
  }
  async endPage(size, offset) {
    return __privateGet$5(this, _query).getPaginated({ pagination: { size, offset, end: this.meta.page.cursor } });
  }
  hasNextPage() {
    return this.meta.page.more;
  }
}
_query = new WeakMap;
var PAGINATION_MAX_SIZE = 1000;
var PAGINATION_DEFAULT_SIZE = 20;
class RecordArray extends Array {
  constructor(...args) {
    super(...RecordArray.parseConstructorParams(...args));
  }
  static parseConstructorParams(...args) {
    if (args.length === 1 && typeof args[0] === "number") {
      return new Array(args[0]);
    }
    if (args.length <= 1 && Array.isArray(args[0] ?? [])) {
      const result = args[0] ?? [];
      return new Array(...result);
    }
    return new Array(...args);
  }
  toArray() {
    return new Array(...this);
  }
  toSerializable() {
    return JSON.parse(this.toString());
  }
  toString() {
    return JSON.stringify(this.toArray());
  }
  map(callbackfn, thisArg) {
    return this.toArray().map(callbackfn, thisArg);
  }
}
var _PageRecordArray = class _PageRecordArray2 extends Array {
  constructor(...args) {
    super(..._PageRecordArray2.parseConstructorParams(...args));
    __privateAdd$6(this, _page);
    __privateSet$4(this, _page, isObject(args[0]?.meta) ? args[0] : { meta: { page: { cursor: "", more: false } }, records: [] });
  }
  static parseConstructorParams(...args) {
    if (args.length === 1 && typeof args[0] === "number") {
      return new Array(args[0]);
    }
    if (args.length <= 2 && isObject(args[0]?.meta) && Array.isArray(args[1] ?? [])) {
      const result = args[1] ?? args[0].records ?? [];
      return new Array(...result);
    }
    return new Array(...args);
  }
  toArray() {
    return new Array(...this);
  }
  toSerializable() {
    return JSON.parse(this.toString());
  }
  toString() {
    return JSON.stringify(this.toArray());
  }
  map(callbackfn, thisArg) {
    return this.toArray().map(callbackfn, thisArg);
  }
  async nextPage(size, offset) {
    const newPage = await __privateGet$5(this, _page).nextPage(size, offset);
    return new _PageRecordArray2(newPage);
  }
  async previousPage(size, offset) {
    const newPage = await __privateGet$5(this, _page).previousPage(size, offset);
    return new _PageRecordArray2(newPage);
  }
  async startPage(size, offset) {
    const newPage = await __privateGet$5(this, _page).startPage(size, offset);
    return new _PageRecordArray2(newPage);
  }
  async endPage(size, offset) {
    const newPage = await __privateGet$5(this, _page).endPage(size, offset);
    return new _PageRecordArray2(newPage);
  }
  hasNextPage() {
    return __privateGet$5(this, _page).meta.page.more;
  }
};
_page = new WeakMap;
var PageRecordArray = _PageRecordArray;
var __typeError$5 = (msg) => {
  throw TypeError(msg);
};
var __accessCheck$5 = (obj, member, msg) => member.has(obj) || __typeError$5("Cannot " + msg);
var __privateGet$4 = (obj, member, getter) => (__accessCheck$5(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd$5 = (obj, member, value) => member.has(obj) ? __typeError$5("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet$3 = (obj, member, value, setter) => (__accessCheck$5(obj, member, "write to private field"), member.set(obj, value), value);
var __privateMethod$3 = (obj, member, method) => (__accessCheck$5(obj, member, "access private method"), method);
var _table$1;
var _repository;
var _data;
var _Query_instances;
var cleanFilterConstraint_fn;
var _Query = class _Query2 {
  constructor(repository, table, data, rawParent) {
    __privateAdd$5(this, _Query_instances);
    __privateAdd$5(this, _table$1);
    __privateAdd$5(this, _repository);
    __privateAdd$5(this, _data, { filter: {} });
    this.meta = { page: { cursor: "start", more: true, size: PAGINATION_DEFAULT_SIZE } };
    this.records = new PageRecordArray(this, []);
    __privateSet$3(this, _table$1, table);
    if (repository) {
      __privateSet$3(this, _repository, repository);
    } else {
      __privateSet$3(this, _repository, this);
    }
    const parent = cleanParent(data, rawParent);
    __privateGet$4(this, _data).filter = data.filter ?? parent?.filter ?? {};
    __privateGet$4(this, _data).filter.$any = data.filter?.$any ?? parent?.filter?.$any;
    __privateGet$4(this, _data).filter.$all = data.filter?.$all ?? parent?.filter?.$all;
    __privateGet$4(this, _data).filter.$not = data.filter?.$not ?? parent?.filter?.$not;
    __privateGet$4(this, _data).filter.$none = data.filter?.$none ?? parent?.filter?.$none;
    __privateGet$4(this, _data).sort = data.sort ?? parent?.sort;
    __privateGet$4(this, _data).columns = data.columns ?? parent?.columns;
    __privateGet$4(this, _data).consistency = data.consistency ?? parent?.consistency;
    __privateGet$4(this, _data).pagination = data.pagination ?? parent?.pagination;
    __privateGet$4(this, _data).cache = data.cache ?? parent?.cache;
    __privateGet$4(this, _data).fetchOptions = data.fetchOptions ?? parent?.fetchOptions;
    this.any = this.any.bind(this);
    this.all = this.all.bind(this);
    this.not = this.not.bind(this);
    this.filter = this.filter.bind(this);
    this.sort = this.sort.bind(this);
    this.none = this.none.bind(this);
    Object.defineProperty(this, "table", { enumerable: false });
    Object.defineProperty(this, "repository", { enumerable: false });
  }
  getQueryOptions() {
    return __privateGet$4(this, _data);
  }
  key() {
    const { columns = [], filter = {}, sort = [], pagination = {} } = __privateGet$4(this, _data);
    const key = JSON.stringify({ columns, filter, sort, pagination });
    return toBase64(key);
  }
  any(...queries) {
    const $any = queries.map((query) => query.getQueryOptions().filter ?? {});
    return new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), { filter: { $any } }, __privateGet$4(this, _data));
  }
  all(...queries) {
    const $all = queries.map((query) => query.getQueryOptions().filter ?? {});
    return new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), { filter: { $all } }, __privateGet$4(this, _data));
  }
  not(...queries) {
    const $not = queries.map((query) => query.getQueryOptions().filter ?? {});
    return new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), { filter: { $not } }, __privateGet$4(this, _data));
  }
  none(...queries) {
    const $none = queries.map((query) => query.getQueryOptions().filter ?? {});
    return new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), { filter: { $none } }, __privateGet$4(this, _data));
  }
  filter(a, b) {
    if (arguments.length === 1) {
      const constraints = Object.entries(a ?? {}).map(([column, constraint]) => ({
        [column]: __privateMethod$3(this, _Query_instances, cleanFilterConstraint_fn).call(this, column, constraint)
      }));
      const $all = compact([__privateGet$4(this, _data).filter?.$all].flat().concat(constraints));
      return new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), { filter: { $all } }, __privateGet$4(this, _data));
    } else {
      const constraints = isDefined(a) && isDefined(b) ? [{ [a]: __privateMethod$3(this, _Query_instances, cleanFilterConstraint_fn).call(this, a, b) }] : undefined;
      const $all = compact([__privateGet$4(this, _data).filter?.$all].flat().concat(constraints));
      return new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), { filter: { $all } }, __privateGet$4(this, _data));
    }
  }
  sort(column, direction = "asc") {
    const originalSort = [__privateGet$4(this, _data).sort ?? []].flat();
    const sort = [...originalSort, { column, direction }];
    return new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), { sort }, __privateGet$4(this, _data));
  }
  select(columns) {
    return new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), { columns }, __privateGet$4(this, _data));
  }
  getPaginated(options = {}) {
    const query = new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), options, __privateGet$4(this, _data));
    return __privateGet$4(this, _repository).query(query);
  }
  async* [Symbol.asyncIterator]() {
    for await (const [record] of this.getIterator({ batchSize: 1 })) {
      yield record;
    }
  }
  async* getIterator(options = {}) {
    const { batchSize = 1 } = options;
    let page = await this.getPaginated({ ...options, pagination: { size: batchSize, offset: 0 } });
    let more = page.hasNextPage();
    yield page.records;
    while (more) {
      page = await page.nextPage();
      more = page.hasNextPage();
      yield page.records;
    }
  }
  async getMany(options = {}) {
    const { pagination = {}, ...rest } = options;
    const { size = PAGINATION_DEFAULT_SIZE, offset } = pagination;
    const batchSize = size <= PAGINATION_MAX_SIZE ? size : PAGINATION_MAX_SIZE;
    let page = await this.getPaginated({ ...rest, pagination: { size: batchSize, offset } });
    const results = [...page.records];
    while (page.hasNextPage() && results.length < size) {
      page = await page.nextPage();
      results.push(...page.records);
    }
    if (page.hasNextPage() && options.pagination?.size === undefined) {
      console.trace("Calling getMany does not return all results. Paginate to get all results or call getAll.");
    }
    const array = new PageRecordArray(page, results.slice(0, size));
    return array;
  }
  async getAll(options = {}) {
    const { batchSize = PAGINATION_MAX_SIZE, ...rest } = options;
    const results = [];
    for await (const page of this.getIterator({ ...rest, batchSize })) {
      results.push(...page);
    }
    return new RecordArray(results);
  }
  async getFirst(options = {}) {
    const records = await this.getMany({ ...options, pagination: { size: 1 } });
    return records[0] ?? null;
  }
  async getFirstOrThrow(options = {}) {
    const records = await this.getMany({ ...options, pagination: { size: 1 } });
    if (records[0] === undefined)
      throw new Error("No results found.");
    return records[0];
  }
  async summarize(params = {}) {
    const { summaries, summariesFilter, ...options } = params;
    const query = new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), options, __privateGet$4(this, _data));
    return __privateGet$4(this, _repository).summarizeTable(query, summaries, summariesFilter);
  }
  cache(ttl) {
    return new _Query2(__privateGet$4(this, _repository), __privateGet$4(this, _table$1), { cache: ttl }, __privateGet$4(this, _data));
  }
  nextPage(size, offset) {
    return this.startPage(size, offset);
  }
  previousPage(size, offset) {
    return this.startPage(size, offset);
  }
  startPage(size, offset) {
    return this.getPaginated({ pagination: { size, offset } });
  }
  endPage(size, offset) {
    return this.getPaginated({ pagination: { size, offset, before: "end" } });
  }
  hasNextPage() {
    return this.meta.page.more;
  }
};
_table$1 = new WeakMap;
_repository = new WeakMap;
_data = new WeakMap;
_Query_instances = new WeakSet;
cleanFilterConstraint_fn = function(column, value) {
  const columnType = __privateGet$4(this, _table$1).schema?.columns.find(({ name }) => name === column)?.type;
  if (columnType === "multiple" && (isString(value) || isStringArray(value))) {
    return { $includes: value };
  }
  if (columnType === "link" && isObject(value) && isString(value.id)) {
    return value.id;
  }
  return value;
};
var Query = _Query;
var __typeError$4 = (msg) => {
  throw TypeError(msg);
};
var __accessCheck$4 = (obj, member, msg) => member.has(obj) || __typeError$4("Cannot " + msg);
var __privateGet$3 = (obj, member, getter) => (__accessCheck$4(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd$4 = (obj, member, value) => member.has(obj) ? __typeError$4("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet$2 = (obj, member, value, setter) => (__accessCheck$4(obj, member, "write to private field"), member.set(obj, value), value);
var __privateMethod$2 = (obj, member, method) => (__accessCheck$4(obj, member, "access private method"), method);
var _table;
var _getFetchProps;
var _db;
var _cache;
var _schemaTables;
var _trace;
var _RestRepository_instances;
var insertRecordWithoutId_fn;
var insertRecordWithId_fn;
var insertRecords_fn;
var updateRecordWithID_fn;
var updateRecords_fn;
var upsertRecordWithID_fn;
var deleteRecord_fn;
var deleteRecords_fn;
var setCacheQuery_fn;
var getCacheQuery_fn;
var getSchemaTables_fn;
var transformObjectToApi_fn;
var BULK_OPERATION_MAX_SIZE = 1000;
class RestRepository extends Query {
  constructor(options) {
    super(null, { name: options.table, schema: options.schemaTables?.find((table) => table.name === options.table) }, {});
    __privateAdd$4(this, _RestRepository_instances);
    __privateAdd$4(this, _table);
    __privateAdd$4(this, _getFetchProps);
    __privateAdd$4(this, _db);
    __privateAdd$4(this, _cache);
    __privateAdd$4(this, _schemaTables);
    __privateAdd$4(this, _trace);
    __privateSet$2(this, _table, options.table);
    __privateSet$2(this, _db, options.db);
    __privateSet$2(this, _cache, options.pluginOptions.cache);
    __privateSet$2(this, _schemaTables, options.schemaTables);
    __privateSet$2(this, _getFetchProps, () => ({ ...options.pluginOptions, sessionID: generateUUID() }));
    const trace = options.pluginOptions.trace ?? defaultTrace;
    __privateSet$2(this, _trace, async (name, fn, options2 = {}) => {
      return trace(name, fn, {
        ...options2,
        [TraceAttributes.TABLE]: __privateGet$3(this, _table),
        [TraceAttributes.KIND]: "sdk-operation",
        [TraceAttributes.VERSION]: VERSION
      });
    });
  }
  async create(a, b, c, d) {
    return __privateGet$3(this, _trace).call(this, "create", async () => {
      const ifVersion = parseIfVersion(b, c, d);
      if (Array.isArray(a)) {
        if (a.length === 0)
          return [];
        const ids = await __privateMethod$2(this, _RestRepository_instances, insertRecords_fn).call(this, a, { ifVersion, createOnly: true });
        const columns = isValidSelectableColumns(b) ? b : ["*"];
        const result = await this.read(ids, columns);
        return result;
      }
      if (isString(a) && isObject(b)) {
        if (a === "")
          throw new Error("The id can't be empty");
        const columns = isValidSelectableColumns(c) ? c : undefined;
        return await __privateMethod$2(this, _RestRepository_instances, insertRecordWithId_fn).call(this, a, b, columns, { createOnly: true, ifVersion });
      }
      if (isObject(a) && isString(a.id)) {
        if (a.id === "")
          throw new Error("The id can't be empty");
        const columns = isValidSelectableColumns(b) ? b : undefined;
        return await __privateMethod$2(this, _RestRepository_instances, insertRecordWithId_fn).call(this, a.id, { ...a, id: undefined }, columns, { createOnly: true, ifVersion });
      }
      if (isObject(a)) {
        const columns = isValidSelectableColumns(b) ? b : undefined;
        return __privateMethod$2(this, _RestRepository_instances, insertRecordWithoutId_fn).call(this, a, columns);
      }
      throw new Error("Invalid arguments for create method");
    });
  }
  async read(a, b) {
    return __privateGet$3(this, _trace).call(this, "read", async () => {
      const columns = isValidSelectableColumns(b) ? b : ["*"];
      if (Array.isArray(a)) {
        if (a.length === 0)
          return [];
        const ids = a.map((item) => extractId(item));
        const finalObjects = await this.getAll({ filter: { id: { $any: compact(ids) } }, columns });
        const dictionary = finalObjects.reduce((acc, object) => {
          acc[object.id] = object;
          return acc;
        }, {});
        return ids.map((id2) => dictionary[id2 ?? ""] ?? null);
      }
      const id = extractId(a);
      if (id) {
        try {
          const response = await getRecord({
            pathParams: {
              workspace: "{workspaceId}",
              dbBranchName: "{dbBranch}",
              region: "{region}",
              tableName: __privateGet$3(this, _table),
              recordId: id
            },
            queryParams: { columns },
            ...__privateGet$3(this, _getFetchProps).call(this)
          });
          const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
          return initObject(__privateGet$3(this, _db), schemaTables, __privateGet$3(this, _table), response, columns);
        } catch (e) {
          if (isObject(e) && e.status === 404) {
            return null;
          }
          throw e;
        }
      }
      return null;
    });
  }
  async readOrThrow(a, b) {
    return __privateGet$3(this, _trace).call(this, "readOrThrow", async () => {
      const result = await this.read(a, b);
      if (Array.isArray(result)) {
        const missingIds = compact(a.filter((_item, index) => result[index] === null).map((item) => extractId(item)));
        if (missingIds.length > 0) {
          throw new Error(`Could not find records with ids: ${missingIds.join(", ")}`);
        }
        return result;
      }
      if (result === null) {
        const id = extractId(a) ?? "unknown";
        throw new Error(`Record with id ${id} not found`);
      }
      return result;
    });
  }
  async update(a, b, c, d) {
    return __privateGet$3(this, _trace).call(this, "update", async () => {
      const ifVersion = parseIfVersion(b, c, d);
      if (Array.isArray(a)) {
        if (a.length === 0)
          return [];
        const existing = await this.read(a, ["id"]);
        const updates = a.filter((_item, index) => existing[index] !== null);
        await __privateMethod$2(this, _RestRepository_instances, updateRecords_fn).call(this, updates, {
          ifVersion,
          upsert: false
        });
        const columns = isValidSelectableColumns(b) ? b : ["*"];
        const result = await this.read(a, columns);
        return result;
      }
      try {
        if (isString(a) && isObject(b)) {
          const columns = isValidSelectableColumns(c) ? c : undefined;
          return await __privateMethod$2(this, _RestRepository_instances, updateRecordWithID_fn).call(this, a, b, columns, { ifVersion });
        }
        if (isObject(a) && isString(a.id)) {
          const columns = isValidSelectableColumns(b) ? b : undefined;
          return await __privateMethod$2(this, _RestRepository_instances, updateRecordWithID_fn).call(this, a.id, { ...a, id: undefined }, columns, { ifVersion });
        }
      } catch (error) {
        if (error.status === 422)
          return null;
        throw error;
      }
      throw new Error("Invalid arguments for update method");
    });
  }
  async updateOrThrow(a, b, c, d) {
    return __privateGet$3(this, _trace).call(this, "updateOrThrow", async () => {
      const result = await this.update(a, b, c, d);
      if (Array.isArray(result)) {
        const missingIds = compact(a.filter((_item, index) => result[index] === null).map((item) => extractId(item)));
        if (missingIds.length > 0) {
          throw new Error(`Could not find records with ids: ${missingIds.join(", ")}`);
        }
        return result;
      }
      if (result === null) {
        const id = extractId(a) ?? "unknown";
        throw new Error(`Record with id ${id} not found`);
      }
      return result;
    });
  }
  async createOrUpdate(a, b, c, d) {
    return __privateGet$3(this, _trace).call(this, "createOrUpdate", async () => {
      const ifVersion = parseIfVersion(b, c, d);
      if (Array.isArray(a)) {
        if (a.length === 0)
          return [];
        await __privateMethod$2(this, _RestRepository_instances, updateRecords_fn).call(this, a, {
          ifVersion,
          upsert: true
        });
        const columns = isValidSelectableColumns(b) ? b : ["*"];
        const result = await this.read(a, columns);
        return result;
      }
      if (isString(a) && isObject(b)) {
        if (a === "")
          throw new Error("The id can't be empty");
        const columns = isValidSelectableColumns(c) ? c : undefined;
        return await __privateMethod$2(this, _RestRepository_instances, upsertRecordWithID_fn).call(this, a, b, columns, { ifVersion });
      }
      if (isObject(a) && isString(a.id)) {
        if (a.id === "")
          throw new Error("The id can't be empty");
        const columns = isValidSelectableColumns(c) ? c : undefined;
        return await __privateMethod$2(this, _RestRepository_instances, upsertRecordWithID_fn).call(this, a.id, { ...a, id: undefined }, columns, { ifVersion });
      }
      if (!isDefined(a) && isObject(b)) {
        return await this.create(b, c);
      }
      if (isObject(a) && !isDefined(a.id)) {
        return await this.create(a, b);
      }
      throw new Error("Invalid arguments for createOrUpdate method");
    });
  }
  async createOrReplace(a, b, c, d) {
    return __privateGet$3(this, _trace).call(this, "createOrReplace", async () => {
      const ifVersion = parseIfVersion(b, c, d);
      if (Array.isArray(a)) {
        if (a.length === 0)
          return [];
        const ids = await __privateMethod$2(this, _RestRepository_instances, insertRecords_fn).call(this, a, { ifVersion, createOnly: false });
        const columns = isValidSelectableColumns(b) ? b : ["*"];
        const result = await this.read(ids, columns);
        return result;
      }
      if (isString(a) && isObject(b)) {
        if (a === "")
          throw new Error("The id can't be empty");
        const columns = isValidSelectableColumns(c) ? c : undefined;
        return await __privateMethod$2(this, _RestRepository_instances, insertRecordWithId_fn).call(this, a, b, columns, { createOnly: false, ifVersion });
      }
      if (isObject(a) && isString(a.id)) {
        if (a.id === "")
          throw new Error("The id can't be empty");
        const columns = isValidSelectableColumns(c) ? c : undefined;
        return await __privateMethod$2(this, _RestRepository_instances, insertRecordWithId_fn).call(this, a.id, { ...a, id: undefined }, columns, { createOnly: false, ifVersion });
      }
      if (!isDefined(a) && isObject(b)) {
        return await this.create(b, c);
      }
      if (isObject(a) && !isDefined(a.id)) {
        return await this.create(a, b);
      }
      throw new Error("Invalid arguments for createOrReplace method");
    });
  }
  async delete(a, b) {
    return __privateGet$3(this, _trace).call(this, "delete", async () => {
      if (Array.isArray(a)) {
        if (a.length === 0)
          return [];
        const ids = a.map((o) => {
          if (isString(o))
            return o;
          if (isString(o.id))
            return o.id;
          throw new Error("Invalid arguments for delete method");
        });
        const columns = isValidSelectableColumns(b) ? b : ["*"];
        const result = await this.read(a, columns);
        await __privateMethod$2(this, _RestRepository_instances, deleteRecords_fn).call(this, ids);
        return result;
      }
      if (isString(a)) {
        return __privateMethod$2(this, _RestRepository_instances, deleteRecord_fn).call(this, a, b);
      }
      if (isObject(a) && isString(a.id)) {
        return __privateMethod$2(this, _RestRepository_instances, deleteRecord_fn).call(this, a.id, b);
      }
      throw new Error("Invalid arguments for delete method");
    });
  }
  async deleteOrThrow(a, b) {
    return __privateGet$3(this, _trace).call(this, "deleteOrThrow", async () => {
      const result = await this.delete(a, b);
      if (Array.isArray(result)) {
        const missingIds = compact(a.filter((_item, index) => result[index] === null).map((item) => extractId(item)));
        if (missingIds.length > 0) {
          throw new Error(`Could not find records with ids: ${missingIds.join(", ")}`);
        }
        return result;
      } else if (result === null) {
        const id = extractId(a) ?? "unknown";
        throw new Error(`Record with id ${id} not found`);
      }
      return result;
    });
  }
  async search(query, options = {}) {
    return __privateGet$3(this, _trace).call(this, "search", async () => {
      const { records, totalCount } = await searchTable({
        pathParams: {
          workspace: "{workspaceId}",
          dbBranchName: "{dbBranch}",
          region: "{region}",
          tableName: __privateGet$3(this, _table)
        },
        body: {
          query,
          fuzziness: options.fuzziness,
          prefix: options.prefix,
          highlight: options.highlight,
          filter: options.filter,
          boosters: options.boosters,
          page: options.page,
          target: options.target
        },
        ...__privateGet$3(this, _getFetchProps).call(this)
      });
      const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
      return {
        records: records.map((item) => initObject(__privateGet$3(this, _db), schemaTables, __privateGet$3(this, _table), item, ["*"])),
        totalCount
      };
    });
  }
  async vectorSearch(column, query, options) {
    return __privateGet$3(this, _trace).call(this, "vectorSearch", async () => {
      const { records, totalCount } = await vectorSearchTable({
        pathParams: {
          workspace: "{workspaceId}",
          dbBranchName: "{dbBranch}",
          region: "{region}",
          tableName: __privateGet$3(this, _table)
        },
        body: {
          column,
          queryVector: query,
          similarityFunction: options?.similarityFunction,
          size: options?.size,
          filter: options?.filter
        },
        ...__privateGet$3(this, _getFetchProps).call(this)
      });
      const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
      return {
        records: records.map((item) => initObject(__privateGet$3(this, _db), schemaTables, __privateGet$3(this, _table), item, ["*"])),
        totalCount
      };
    });
  }
  async aggregate(aggs, filter) {
    return __privateGet$3(this, _trace).call(this, "aggregate", async () => {
      const result = await aggregateTable({
        pathParams: {
          workspace: "{workspaceId}",
          dbBranchName: "{dbBranch}",
          region: "{region}",
          tableName: __privateGet$3(this, _table)
        },
        body: { aggs, filter },
        ...__privateGet$3(this, _getFetchProps).call(this)
      });
      return result;
    });
  }
  async query(query) {
    return __privateGet$3(this, _trace).call(this, "query", async () => {
      const cacheQuery = await __privateMethod$2(this, _RestRepository_instances, getCacheQuery_fn).call(this, query);
      if (cacheQuery)
        return new Page(query, cacheQuery.meta, cacheQuery.records);
      const data = query.getQueryOptions();
      const { meta, records: objects } = await queryTable({
        pathParams: {
          workspace: "{workspaceId}",
          dbBranchName: "{dbBranch}",
          region: "{region}",
          tableName: __privateGet$3(this, _table)
        },
        body: {
          filter: cleanFilter(data.filter),
          sort: data.sort !== undefined ? buildSortFilter(data.sort) : undefined,
          page: data.pagination,
          columns: data.columns ?? ["*"],
          consistency: data.consistency
        },
        fetchOptions: data.fetchOptions,
        ...__privateGet$3(this, _getFetchProps).call(this)
      });
      const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
      const records = objects.map((record) => initObject(__privateGet$3(this, _db), schemaTables, __privateGet$3(this, _table), record, data.columns ?? ["*"]));
      await __privateMethod$2(this, _RestRepository_instances, setCacheQuery_fn).call(this, query, meta, records);
      return new Page(query, meta, records);
    });
  }
  async summarizeTable(query, summaries, summariesFilter) {
    return __privateGet$3(this, _trace).call(this, "summarize", async () => {
      const data = query.getQueryOptions();
      const result = await summarizeTable({
        pathParams: {
          workspace: "{workspaceId}",
          dbBranchName: "{dbBranch}",
          region: "{region}",
          tableName: __privateGet$3(this, _table)
        },
        body: {
          filter: cleanFilter(data.filter),
          sort: data.sort !== undefined ? buildSortFilter(data.sort) : undefined,
          columns: data.columns,
          consistency: data.consistency,
          page: data.pagination?.size !== undefined ? { size: data.pagination?.size } : undefined,
          summaries,
          summariesFilter
        },
        ...__privateGet$3(this, _getFetchProps).call(this)
      });
      const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
      return {
        ...result,
        summaries: result.summaries.map((summary) => initObject(__privateGet$3(this, _db), schemaTables, __privateGet$3(this, _table), summary, data.columns ?? []))
      };
    });
  }
  ask(question, options) {
    const questionParam = options?.sessionId ? { message: question } : { question };
    const params = {
      pathParams: {
        workspace: "{workspaceId}",
        dbBranchName: "{dbBranch}",
        region: "{region}",
        tableName: __privateGet$3(this, _table),
        sessionId: options?.sessionId
      },
      body: {
        ...questionParam,
        rules: options?.rules,
        searchType: options?.searchType,
        search: options?.searchType === "keyword" ? options?.search : undefined,
        vectorSearch: options?.searchType === "vector" ? options?.vectorSearch : undefined
      },
      ...__privateGet$3(this, _getFetchProps).call(this)
    };
    if (options?.onMessage) {
      fetchSSERequest({
        endpoint: "dataPlane",
        url: "/db/{dbBranchName}/tables/{tableName}/ask/{sessionId}",
        method: "POST",
        onMessage: (message) => {
          options.onMessage?.({ answer: message.text, records: message.records });
        },
        ...params
      });
    } else {
      return askTableSession(params);
    }
  }
}
_table = new WeakMap;
_getFetchProps = new WeakMap;
_db = new WeakMap;
_cache = new WeakMap;
_schemaTables = new WeakMap;
_trace = new WeakMap;
_RestRepository_instances = new WeakSet;
insertRecordWithoutId_fn = async function(object, columns = ["*"]) {
  const record = await __privateMethod$2(this, _RestRepository_instances, transformObjectToApi_fn).call(this, object);
  const response = await insertRecord({
    pathParams: {
      workspace: "{workspaceId}",
      dbBranchName: "{dbBranch}",
      region: "{region}",
      tableName: __privateGet$3(this, _table)
    },
    queryParams: { columns },
    body: record,
    ...__privateGet$3(this, _getFetchProps).call(this)
  });
  const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
  return initObject(__privateGet$3(this, _db), schemaTables, __privateGet$3(this, _table), response, columns);
};
insertRecordWithId_fn = async function(recordId, object, columns = ["*"], { createOnly, ifVersion }) {
  if (!recordId)
    return null;
  const record = await __privateMethod$2(this, _RestRepository_instances, transformObjectToApi_fn).call(this, object);
  const response = await insertRecordWithID({
    pathParams: {
      workspace: "{workspaceId}",
      dbBranchName: "{dbBranch}",
      region: "{region}",
      tableName: __privateGet$3(this, _table),
      recordId
    },
    body: record,
    queryParams: { createOnly, columns, ifVersion },
    ...__privateGet$3(this, _getFetchProps).call(this)
  });
  const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
  return initObject(__privateGet$3(this, _db), schemaTables, __privateGet$3(this, _table), response, columns);
};
insertRecords_fn = async function(objects, { createOnly, ifVersion }) {
  const operations = await promiseMap(objects, async (object) => {
    const record = await __privateMethod$2(this, _RestRepository_instances, transformObjectToApi_fn).call(this, object);
    return { insert: { table: __privateGet$3(this, _table), record, createOnly, ifVersion } };
  });
  const chunkedOperations = chunk(operations, BULK_OPERATION_MAX_SIZE);
  const ids = [];
  for (const operations2 of chunkedOperations) {
    const { results } = await branchTransaction({
      pathParams: {
        workspace: "{workspaceId}",
        dbBranchName: "{dbBranch}",
        region: "{region}"
      },
      body: { operations: operations2 },
      ...__privateGet$3(this, _getFetchProps).call(this)
    });
    for (const result of results) {
      if (result.operation === "insert") {
        ids.push(result.id);
      } else {
        ids.push(null);
      }
    }
  }
  return ids;
};
updateRecordWithID_fn = async function(recordId, object, columns = ["*"], { ifVersion }) {
  if (!recordId)
    return null;
  const { id: _id, ...record } = await __privateMethod$2(this, _RestRepository_instances, transformObjectToApi_fn).call(this, object);
  try {
    const response = await updateRecordWithID({
      pathParams: {
        workspace: "{workspaceId}",
        dbBranchName: "{dbBranch}",
        region: "{region}",
        tableName: __privateGet$3(this, _table),
        recordId
      },
      queryParams: { columns, ifVersion },
      body: record,
      ...__privateGet$3(this, _getFetchProps).call(this)
    });
    const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
    return initObject(__privateGet$3(this, _db), schemaTables, __privateGet$3(this, _table), response, columns);
  } catch (e) {
    if (isObject(e) && e.status === 404) {
      return null;
    }
    throw e;
  }
};
updateRecords_fn = async function(objects, { ifVersion, upsert }) {
  const operations = await promiseMap(objects, async ({ id, ...object }) => {
    const fields = await __privateMethod$2(this, _RestRepository_instances, transformObjectToApi_fn).call(this, object);
    return { update: { table: __privateGet$3(this, _table), id, ifVersion, upsert, fields } };
  });
  const chunkedOperations = chunk(operations, BULK_OPERATION_MAX_SIZE);
  const ids = [];
  for (const operations2 of chunkedOperations) {
    const { results } = await branchTransaction({
      pathParams: {
        workspace: "{workspaceId}",
        dbBranchName: "{dbBranch}",
        region: "{region}"
      },
      body: { operations: operations2 },
      ...__privateGet$3(this, _getFetchProps).call(this)
    });
    for (const result of results) {
      if (result.operation === "update") {
        ids.push(result.id);
      } else {
        ids.push(null);
      }
    }
  }
  return ids;
};
upsertRecordWithID_fn = async function(recordId, object, columns = ["*"], { ifVersion }) {
  if (!recordId)
    return null;
  const response = await upsertRecordWithID({
    pathParams: {
      workspace: "{workspaceId}",
      dbBranchName: "{dbBranch}",
      region: "{region}",
      tableName: __privateGet$3(this, _table),
      recordId
    },
    queryParams: { columns, ifVersion },
    body: object,
    ...__privateGet$3(this, _getFetchProps).call(this)
  });
  const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
  return initObject(__privateGet$3(this, _db), schemaTables, __privateGet$3(this, _table), response, columns);
};
deleteRecord_fn = async function(recordId, columns = ["*"]) {
  if (!recordId)
    return null;
  try {
    const response = await deleteRecord({
      pathParams: {
        workspace: "{workspaceId}",
        dbBranchName: "{dbBranch}",
        region: "{region}",
        tableName: __privateGet$3(this, _table),
        recordId
      },
      queryParams: { columns },
      ...__privateGet$3(this, _getFetchProps).call(this)
    });
    const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
    return initObject(__privateGet$3(this, _db), schemaTables, __privateGet$3(this, _table), response, columns);
  } catch (e) {
    if (isObject(e) && e.status === 404) {
      return null;
    }
    throw e;
  }
};
deleteRecords_fn = async function(recordIds) {
  const chunkedOperations = chunk(compact(recordIds).map((id) => ({ delete: { table: __privateGet$3(this, _table), id } })), BULK_OPERATION_MAX_SIZE);
  for (const operations of chunkedOperations) {
    await branchTransaction({
      pathParams: {
        workspace: "{workspaceId}",
        dbBranchName: "{dbBranch}",
        region: "{region}"
      },
      body: { operations },
      ...__privateGet$3(this, _getFetchProps).call(this)
    });
  }
};
setCacheQuery_fn = async function(query, meta, records) {
  await __privateGet$3(this, _cache)?.set(`query_${__privateGet$3(this, _table)}:${query.key()}`, { date: new Date, meta, records });
};
getCacheQuery_fn = async function(query) {
  const key = `query_${__privateGet$3(this, _table)}:${query.key()}`;
  const result = await __privateGet$3(this, _cache)?.get(key);
  if (!result)
    return null;
  const defaultTTL = __privateGet$3(this, _cache)?.defaultQueryTTL ?? -1;
  const { cache: ttl = defaultTTL } = query.getQueryOptions();
  if (ttl < 0)
    return null;
  const hasExpired = result.date.getTime() + ttl < Date.now();
  return hasExpired ? null : result;
};
getSchemaTables_fn = async function() {
  if (__privateGet$3(this, _schemaTables))
    return __privateGet$3(this, _schemaTables);
  const { schema } = await getBranchDetails({
    pathParams: { workspace: "{workspaceId}", dbBranchName: "{dbBranch}", region: "{region}" },
    ...__privateGet$3(this, _getFetchProps).call(this)
  });
  __privateSet$2(this, _schemaTables, schema.tables);
  return schema.tables;
};
transformObjectToApi_fn = async function(object) {
  const schemaTables = await __privateMethod$2(this, _RestRepository_instances, getSchemaTables_fn).call(this);
  const schema = schemaTables.find((table) => table.name === __privateGet$3(this, _table));
  if (!schema)
    throw new Error(`Table ${__privateGet$3(this, _table)} not found in schema`);
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    if (key === "xata")
      continue;
    const type = schema.columns.find((column) => column.name === key)?.type;
    switch (type) {
      case "link": {
        result[key] = isIdentifiable(value) ? value.id : value;
        break;
      }
      case "datetime": {
        result[key] = value instanceof Date ? value.toISOString() : value;
        break;
      }
      case `file`:
        result[key] = await parseInputFileEntry(value);
        break;
      case "file[]":
        result[key] = await promiseMap(value, (item) => parseInputFileEntry(item));
        break;
      case "json":
        result[key] = stringifyJson(value);
        break;
      default:
        result[key] = value;
    }
  }
  return result;
};
var initObject = (db, schemaTables, table, object, selectedColumns) => {
  const data = {};
  const { xata, ...rest } = object ?? {};
  Object.assign(data, rest);
  const { columns } = schemaTables.find(({ name }) => name === table) ?? {};
  if (!columns)
    console.error(`Table ${table} not found in schema`);
  for (const column of columns ?? []) {
    if (!isValidColumn(selectedColumns, column))
      continue;
    const value = data[column.name];
    switch (column.type) {
      case "datetime": {
        const date = value !== undefined ? new Date(value) : null;
        if (date !== null && isNaN(date.getTime())) {
          console.error(`Failed to parse date ${value} for field ${column.name}`);
        } else {
          data[column.name] = date;
        }
        break;
      }
      case "link": {
        const linkTable = column.link?.table;
        if (!linkTable) {
          console.error(`Failed to parse link for field ${column.name}`);
        } else if (isObject(value)) {
          const selectedLinkColumns = selectedColumns.reduce((acc, item) => {
            if (item === column.name) {
              return [...acc, "*"];
            }
            if (isString(item) && item.startsWith(`${column.name}.`)) {
              const [, ...path] = item.split(".");
              return [...acc, path.join(".")];
            }
            return acc;
          }, []);
          data[column.name] = initObject(db, schemaTables, linkTable, value, selectedLinkColumns);
        } else {
          data[column.name] = null;
        }
        break;
      }
      case "file":
        data[column.name] = isDefined(value) ? new XataFile(value) : null;
        break;
      case "file[]":
        data[column.name] = value?.map((item) => new XataFile(item)) ?? null;
        break;
      case "json":
        data[column.name] = parseJson(value);
        break;
      default:
        data[column.name] = value ?? null;
        if (column.notNull === true && value === null) {
          console.error(`Parse error, column ${column.name} is non nullable and value resolves null`);
        }
        break;
    }
  }
  const record = { ...data };
  const metadata = xata !== undefined ? { ...xata, createdAt: new Date(xata.createdAt), updatedAt: new Date(xata.updatedAt) } : undefined;
  record.read = function(columns2) {
    return db[table].read(record["id"], columns2);
  };
  record.update = function(data2, b, c) {
    const columns2 = isValidSelectableColumns(b) ? b : ["*"];
    const ifVersion = parseIfVersion(b, c);
    return db[table].update(record["id"], data2, columns2, { ifVersion });
  };
  record.replace = function(data2, b, c) {
    const columns2 = isValidSelectableColumns(b) ? b : ["*"];
    const ifVersion = parseIfVersion(b, c);
    return db[table].createOrReplace(record["id"], data2, columns2, { ifVersion });
  };
  record.delete = function() {
    return db[table].delete(record["id"]);
  };
  if (metadata !== undefined) {
    record.xata = Object.freeze(metadata);
  }
  record.getMetadata = function() {
    return record.xata;
  };
  record.toSerializable = function() {
    return JSON.parse(JSON.stringify(record));
  };
  record.toString = function() {
    return JSON.stringify(record);
  };
  for (const prop of ["read", "update", "replace", "delete", "getMetadata", "toSerializable", "toString"]) {
    Object.defineProperty(record, prop, { enumerable: false });
  }
  Object.freeze(record);
  return record;
};
var __typeError$3 = (msg) => {
  throw TypeError(msg);
};
var __accessCheck$3 = (obj, member, msg) => member.has(obj) || __typeError$3("Cannot " + msg);
var __privateGet$2 = (obj, member, getter) => (__accessCheck$3(obj, member, "read from private field"), member.get(obj));
var __privateAdd$3 = (obj, member, value) => member.has(obj) ? __typeError$3("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet$1 = (obj, member, value, setter) => (__accessCheck$3(obj, member, "write to private field"), member.set(obj, value), value);
var _map;

class SimpleCache {
  constructor(options = {}) {
    __privateAdd$3(this, _map);
    __privateSet$1(this, _map, new Map);
    this.capacity = options.max ?? 500;
    this.defaultQueryTTL = options.defaultQueryTTL ?? 60 * 1000;
  }
  async getAll() {
    return Object.fromEntries(__privateGet$2(this, _map));
  }
  async get(key) {
    return __privateGet$2(this, _map).get(key) ?? null;
  }
  async set(key, value) {
    await this.delete(key);
    __privateGet$2(this, _map).set(key, value);
    if (__privateGet$2(this, _map).size > this.capacity) {
      const leastRecentlyUsed = __privateGet$2(this, _map).keys().next().value;
      await this.delete(leastRecentlyUsed);
    }
  }
  async delete(key) {
    __privateGet$2(this, _map).delete(key);
  }
  async clear() {
    return __privateGet$2(this, _map).clear();
  }
}
_map = new WeakMap;
var __typeError$2 = (msg) => {
  throw TypeError(msg);
};
var __accessCheck$2 = (obj, member, msg) => member.has(obj) || __typeError$2("Cannot " + msg);
var __privateGet$1 = (obj, member, getter) => (__accessCheck$2(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd$2 = (obj, member, value) => member.has(obj) ? __typeError$2("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var _tables;

class SchemaPlugin extends XataPlugin {
  constructor() {
    super();
    __privateAdd$2(this, _tables, {});
  }
  build(pluginOptions) {
    const db = new Proxy({}, {
      get: (_target, table) => {
        if (!isString(table))
          throw new Error("Invalid table name");
        if (__privateGet$1(this, _tables)[table] === undefined) {
          __privateGet$1(this, _tables)[table] = new RestRepository({ db, pluginOptions, table, schemaTables: pluginOptions.tables });
        }
        return __privateGet$1(this, _tables)[table];
      }
    });
    const tableNames = pluginOptions.tables?.map(({ name }) => name) ?? [];
    for (const table of tableNames) {
      db[table] = new RestRepository({ db, pluginOptions, table, schemaTables: pluginOptions.tables });
    }
    return db;
  }
}
_tables = new WeakMap;

class FilesPlugin extends XataPlugin {
  build(pluginOptions) {
    return {
      download: async (location) => {
        const { table, record, column, fileId = "" } = location ?? {};
        return await getFileItem({
          pathParams: {
            workspace: "{workspaceId}",
            dbBranchName: "{dbBranch}",
            region: "{region}",
            tableName: table ?? "",
            recordId: record ?? "",
            columnName: column ?? "",
            fileId
          },
          ...pluginOptions,
          rawResponse: true
        });
      },
      upload: async (location, file, options) => {
        const { table, record, column, fileId = "" } = location ?? {};
        const resolvedFile = await file;
        const contentType = options?.mediaType || getContentType(resolvedFile);
        const body2 = resolvedFile instanceof XataFile ? resolvedFile.toBlob() : resolvedFile;
        return await putFileItem({
          ...pluginOptions,
          pathParams: {
            workspace: "{workspaceId}",
            dbBranchName: "{dbBranch}",
            region: "{region}",
            tableName: table ?? "",
            recordId: record ?? "",
            columnName: column ?? "",
            fileId
          },
          body: body2,
          headers: { "Content-Type": contentType }
        });
      },
      delete: async (location) => {
        const { table, record, column, fileId = "" } = location ?? {};
        return await deleteFileItem({
          pathParams: {
            workspace: "{workspaceId}",
            dbBranchName: "{dbBranch}",
            region: "{region}",
            tableName: table ?? "",
            recordId: record ?? "",
            columnName: column ?? "",
            fileId
          },
          ...pluginOptions
        });
      }
    };
  }
}
var __typeError$1 = (msg) => {
  throw TypeError(msg);
};
var __accessCheck$1 = (obj, member, msg) => member.has(obj) || __typeError$1("Cannot " + msg);
var __privateAdd$1 = (obj, member, value) => member.has(obj) ? __typeError$1("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateMethod$1 = (obj, member, method) => (__accessCheck$1(obj, member, "access private method"), method);
var _SearchPlugin_instances;
var search_fn;

class SearchPlugin extends XataPlugin {
  constructor(db) {
    super();
    this.db = db;
    __privateAdd$1(this, _SearchPlugin_instances);
  }
  build(pluginOptions) {
    return {
      all: async (query, options = {}) => {
        const { records, totalCount } = await __privateMethod$1(this, _SearchPlugin_instances, search_fn).call(this, query, options, pluginOptions);
        return {
          totalCount,
          records: records.map((record) => {
            const { table = "orphan" } = record.xata;
            return { table, record: initObject(this.db, pluginOptions.tables, table, record, ["*"]) };
          })
        };
      },
      byTable: async (query, options = {}) => {
        const { records: rawRecords, totalCount } = await __privateMethod$1(this, _SearchPlugin_instances, search_fn).call(this, query, options, pluginOptions);
        const records = rawRecords.reduce((acc, record) => {
          const { table = "orphan" } = record.xata;
          const items = acc[table] ?? [];
          const item = initObject(this.db, pluginOptions.tables, table, record, ["*"]);
          return { ...acc, [table]: [...items, item] };
        }, {});
        return { totalCount, records };
      }
    };
  }
}
_SearchPlugin_instances = new WeakSet;
search_fn = async function(query, options, pluginOptions) {
  const { tables, fuzziness, highlight, prefix, page } = options ?? {};
  const { records, totalCount } = await searchBranch({
    pathParams: { workspace: "{workspaceId}", dbBranchName: "{dbBranch}", region: "{region}" },
    body: { tables, query, fuzziness, prefix, highlight, page },
    ...pluginOptions
  });
  return { records, totalCount };
};

class SQLPlugin extends XataPlugin {
  build(pluginOptions) {
    const sqlFunction = async (query, ...parameters) => {
      if (!isParamsObject(query) && (!isTemplateStringsArray(query) || !Array.isArray(parameters))) {
        throw new Error("Invalid usage of `xata.sql`. Please use it as a tagged template or with an object.");
      }
      const { statement, params, consistency, responseType } = prepareParams(query, parameters);
      const {
        records,
        rows,
        warning,
        columns = []
      } = await sqlQuery({
        pathParams: { workspace: "{workspaceId}", dbBranchName: "{dbBranch}", region: "{region}" },
        body: { statement, params, consistency, responseType },
        ...pluginOptions
      });
      return { records, rows, warning, columns };
    };
    sqlFunction.connectionString = buildConnectionString(pluginOptions);
    sqlFunction.batch = async (query) => {
      const { results } = await sqlBatchQuery({
        pathParams: { workspace: "{workspaceId}", dbBranchName: "{dbBranch}", region: "{region}" },
        body: {
          statements: query.statements.map(({ statement, params }) => ({ statement, params })),
          consistency: query.consistency,
          responseType: query.responseType
        },
        ...pluginOptions
      });
      return { results };
    };
    return sqlFunction;
  }
}

class TransactionPlugin extends XataPlugin {
  build(pluginOptions) {
    return {
      run: async (operations) => {
        const response = await branchTransaction({
          pathParams: { workspace: "{workspaceId}", dbBranchName: "{dbBranch}", region: "{region}" },
          body: { operations },
          ...pluginOptions
        });
        return response;
      }
    };
  }
}
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);
var buildClient = (plugins) => {
  var _options, _instances, parseOptions_fn, getFetchProps_fn, _a;
  return _a = class {
    constructor(options = {}, tables) {
      __privateAdd(this, _instances);
      __privateAdd(this, _options);
      const safeOptions = __privateMethod(this, _instances, parseOptions_fn).call(this, options);
      __privateSet(this, _options, safeOptions);
      const pluginOptions = {
        ...__privateMethod(this, _instances, getFetchProps_fn).call(this, safeOptions),
        cache: safeOptions.cache,
        host: safeOptions.host,
        tables,
        branch: safeOptions.branch
      };
      const db = new SchemaPlugin().build(pluginOptions);
      const search = new SearchPlugin(db).build(pluginOptions);
      const transactions = new TransactionPlugin().build(pluginOptions);
      const sql = new SQLPlugin().build(pluginOptions);
      const files = new FilesPlugin().build(pluginOptions);
      this.schema = { tables };
      this.db = db;
      this.search = search;
      this.transactions = transactions;
      this.sql = sql;
      this.files = files;
      for (const [key, namespace] of Object.entries(plugins ?? {})) {
        if (namespace === undefined)
          continue;
        this[key] = namespace.build(pluginOptions);
      }
    }
    async getConfig() {
      const databaseURL = __privateGet(this, _options).databaseURL;
      const branch = __privateGet(this, _options).branch;
      return { databaseURL, branch };
    }
  }, _options = new WeakMap, _instances = new WeakSet, parseOptions_fn = function(options) {
    const enableBrowser = options?.enableBrowser ?? getEnableBrowserVariable() ?? false;
    const isBrowser = typeof window !== "undefined" && typeof Deno === "undefined";
    if (isBrowser && !enableBrowser) {
      throw new Error("You are trying to use Xata from the browser, which is potentially a non-secure environment. How to fix: https://xata.io/docs/messages/api-key-browser-error");
    }
    const fetch2 = getFetchImplementation(options?.fetch);
    const databaseURL = options?.databaseURL || getDatabaseURL();
    const apiKey = options?.apiKey || getAPIKey();
    const cache = options?.cache ?? new SimpleCache({ defaultQueryTTL: 0 });
    const trace = options?.trace ?? defaultTrace;
    const clientName = options?.clientName;
    const host = options?.host ?? "production";
    const xataAgentExtra = options?.xataAgentExtra;
    if (!apiKey) {
      throw new Error("Option apiKey is required");
    }
    if (!databaseURL) {
      throw new Error("Option databaseURL is required");
    }
    const envBranch = getBranch();
    const previewBranch = getPreviewBranch();
    const branch = options?.branch || previewBranch || envBranch || "main";
    if (!!previewBranch && branch !== previewBranch) {
      console.warn(`Ignoring preview branch ${previewBranch} because branch option was passed to the client constructor with value ${branch}`);
    } else if (!!envBranch && branch !== envBranch) {
      console.warn(`Ignoring branch ${envBranch} because branch option was passed to the client constructor with value ${branch}`);
    } else if (!!previewBranch && !!envBranch && previewBranch !== envBranch) {
      console.warn(`Ignoring preview branch ${previewBranch} and branch ${envBranch} because branch option was passed to the client constructor with value ${branch}`);
    } else if (!previewBranch && !envBranch && options?.branch === undefined) {
      console.warn(`No branch was passed to the client constructor. Using default branch ${branch}. You can set the branch with the environment variable XATA_BRANCH or by passing the branch option to the client constructor.`);
    }
    return {
      fetch: fetch2,
      databaseURL,
      apiKey,
      branch,
      cache,
      trace,
      host,
      clientID: generateUUID(),
      enableBrowser,
      clientName,
      xataAgentExtra
    };
  }, getFetchProps_fn = function({
    fetch: fetch2,
    apiKey,
    databaseURL,
    branch,
    trace,
    clientID,
    clientName,
    xataAgentExtra
  }) {
    return {
      fetch: fetch2,
      apiKey,
      apiUrl: "",
      workspacesApiUrl: (path, params) => {
        const hasBranch = params.dbBranchName ?? params.branch;
        const newPath = path.replace(/^\/db\/[^/]+/, hasBranch !== undefined ? `:${branch}` : "");
        return databaseURL + newPath;
      },
      trace,
      clientID,
      clientName,
      xataAgentExtra
    };
  }, _a;
};

class BaseClient extends buildClient() {
}
var META = "__";
var VALUE = "___";

class Serializer {
  constructor() {
    this.classes = {};
  }
  add(clazz) {
    this.classes[clazz.name] = clazz;
  }
  toJSON(data) {
    function visit(obj) {
      if (Array.isArray(obj))
        return obj.map(visit);
      const type = typeof obj;
      if (type === "undefined")
        return { [META]: "undefined" };
      if (type === "bigint")
        return { [META]: "bigint", [VALUE]: obj.toString() };
      if (obj === null || type !== "object")
        return obj;
      const constructor = obj.constructor;
      const o = { [META]: constructor.name };
      for (const [key, value] of Object.entries(obj)) {
        o[key] = visit(value);
      }
      if (constructor === Date)
        o[VALUE] = obj.toISOString();
      if (constructor === Map)
        o[VALUE] = Object.fromEntries(obj);
      if (constructor === Set)
        o[VALUE] = [...obj];
      return o;
    }
    return JSON.stringify(visit(data));
  }
  fromJSON(json) {
    return JSON.parse(json, (key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const { [META]: clazz, [VALUE]: val, ...rest } = value;
        const constructor = this.classes[clazz];
        if (constructor) {
          return Object.assign(Object.create(constructor.prototype), rest);
        }
        if (clazz === "Date")
          return new Date(val);
        if (clazz === "Set")
          return new Set(val);
        if (clazz === "Map")
          return new Map(Object.entries(val));
        if (clazz === "bigint")
          return BigInt(val);
        if (clazz === "undefined")
          return;
        return rest;
      }
      return value;
    });
  }
}
var defaultSerializer = new Serializer;

// src/xata.ts
var tables = [
  {
    name: "skills",
    columns: [
      { name: "name", type: "string", unique: true },
      { name: "learned", type: "datetime" },
      { name: "years", type: "int", notNull: true, defaultValue: "0" },
      { name: "level", type: "int", notNull: true, defaultValue: "1" },
      { name: "isPublic", type: "bool", notNull: true, defaultValue: "false" },
      {
        name: "isFeatured",
        type: "bool",
        notNull: true,
        defaultValue: "false"
      },
      { name: "group", type: "string", defaultValue: "general" },
      { name: "notes", type: "text" },
      { name: "logo", type: "file", file: { defaultPublicAccess: true } },
      { name: "link", type: "string" }
    ],
    revLinks: [{ column: "skill", table: "projects_skills" }]
  },
  {
    name: "projects",
    columns: [
      { name: "name", type: "string", unique: true },
      { name: "shortDescription", type: "text" },
      { name: "longDescription", type: "text" },
      { name: "client", type: "string" },
      { name: "role", type: "string" },
      { name: "started", type: "datetime" },
      { name: "ended", type: "datetime" },
      { name: "link", type: "string" },
      { name: "thumbnail", type: "file" },
      { name: "category", type: "string" },
      { name: "showLink", type: "bool", notNull: true, defaultValue: "false" },
      { name: "isCurrent", type: "bool", notNull: true, defaultValue: "false" },
      { name: "hasNotes", type: "bool", notNull: true, defaultValue: "false" },
      {
        name: "isFeatured",
        type: "bool",
        notNull: true,
        defaultValue: "false"
      },
      { name: "isPublic", type: "bool" },
      { name: "slug", type: "string", unique: true },
      { name: "group", type: "string" },
      {
        name: "images",
        type: "file[]",
        "file[]": { defaultPublicAccess: true }
      },
      { name: "skills", type: "multiple" }
    ],
    revLinks: [{ column: "project", table: "projects_skills" }]
  },
  {
    name: "articles",
    columns: [
      { name: "title", type: "string", unique: true },
      { name: "slug", type: "string", unique: true },
      { name: "aboveFold", type: "text" },
      { name: "content", type: "text" },
      { name: "tags", type: "multiple" },
      { name: "category", type: "string" }
    ]
  },
  {
    name: "details",
    columns: [
      { name: "group", type: "string" },
      { name: "content", type: "string" },
      { name: "icon", type: "string" },
      { name: "label", type: "string", unique: true },
      { name: "link", type: "string" }
    ]
  },
  {
    name: "schools",
    columns: [
      { name: "name", type: "string", unique: true },
      { name: "gpa", type: "float", notNull: true, defaultValue: "4.0" },
      { name: "gpaMax", type: "float", notNull: true, defaultValue: "4.0" },
      { name: "start", type: "datetime" },
      { name: "end", type: "datetime" },
      { name: "degree", type: "string" },
      { name: "major", type: "string" },
      { name: "minor", type: "string" },
      { name: "honors", type: "string" },
      { name: "isCurrent", type: "bool", notNull: true, defaultValue: "false" },
      { name: "isPublic", type: "bool", notNull: true, defaultValue: "false" },
      { name: "notes", type: "text" },
      { name: "link", type: "string" },
      { name: "logo", type: "file" }
    ]
  },
  {
    name: "content",
    columns: [
      { name: "slug", type: "string", unique: true },
      { name: "body", type: "text" },
      { name: "isPublic", type: "bool", notNull: true, defaultValue: "false" },
      { name: "group", type: "string", notNull: true, defaultValue: "unset" }
    ]
  },
  {
    name: "projects_skills",
    columns: [
      { name: "project", type: "link", link: { table: "projects" } },
      { name: "skill", type: "link", link: { table: "skills" } }
    ]
  },
  {
    name: "users",
    columns: [
      { name: "username", type: "string", unique: true },
      { name: "password", type: "string" },
      { name: "firstName", type: "string" },
      { name: "lastName", type: "string" },
      { name: "email", type: "string" }
    ]
  }
];
var DatabaseClient = buildClient();
var defaultOptions = {
  databaseURL: "https://Personal-pk6f8v.us-east-1.xata.sh/db/corbin"
};

class XataClient extends DatabaseClient {
  constructor(options) {
    super({ ...defaultOptions, ...options }, tables);
  }
}
var instance = undefined;
var getXataClient = () => {
  if (instance)
    return instance;
  instance = new XataClient;
  return instance;
};

// src/routes/articles.ts
var xata2 = getXataClient();
var articles = new Hono2;
articles.post("getWithFilters", async (c) => {
  const { size, offset, tags } = await c.req.json();
  const page = await xata2.db.articles.select(["title", "slug", "aboveFold", "tags", "category"]).filter({
    category: { $any: tags }
  }).sort("xata.createdAt", "desc").getPaginated({
    pagination: {
      size,
      offset: Number(offset * size)
    }
  });
  return c.json(page);
});
articles.get("single/:slug", async (c) => {
  const slug = c.req.param("slug");
  const article = await xata2.db.articles.filter({ slug }).getFirst();
  return c.json(article);
});
var articles_default = articles;

// src/routes/skills.ts
var skills = new Hono2;
var xata4 = getXataClient();
skills.get("/", async (c) => {
  const skills2 = await xata4.db["skills"].select([
    "name",
    "learned",
    "years",
    "level",
    "isPublic",
    "isFeatured",
    "group",
    "notes",
    "link"
  ]).getAll();
  return c.json(skills2);
});
skills.get("/list", async (c) => {
  const skills2 = await xata4.db["skills"].select([
    "name"
  ]).getAll();
  return c.json(skills2);
});
skills.get("/byID/:id", async (c) => {
  const skillID = c.req.param("id");
  const skill = await xata4.db["skills"].read(skillID);
  return c.json(skill);
});
skills.get("/byName/:name", async (c) => {
  const name = c.req.param("name");
  const skill = await xata4.db["skills"].filter({ name }).getFirst();
  return c.json(skill);
});
skills.get("/byProject/:id", async (c) => {
  const projectID = c.req.param("id");
  const skills2 = await xata4.db.projects_skills.filter({ "project.id": projectID }).select(["skill.id", "skill.name", "skill.isFeatured"]).getAll();
  return c.json(skills2);
});
var skills_default = skills;

// src/routes/projects.ts
var xata6 = getXataClient();
var projects = new Hono2;
projects.get("/", async (c) => {
  let projects2 = await xata6.db.projects.select([
    "name",
    "thumbnail.url",
    "slug",
    "shortDescription",
    "hasNotes",
    "showLink",
    "link",
    "group",
    "category"
  ]).sort("started", "desc").getAll();
  return c.json(projects2);
});
projects.get("/forCV", async (c) => {
  let projects2 = await xata6.db.projects.select(["name", "role", "skills", "shortDescription", "link"]).sort("started", "desc").getAll();
  return c.json(projects2);
});
projects.get("/stubs", async (c) => {
  let projects2 = await xata6.db.projects.select(["name", "started", "ended", "group", "slug"]).sort("started", "desc").getAll();
  console.log(projects2);
  return c.json(projects2);
});
projects.get("/byGroup/:group", async (c) => {
  const group = c.req.param("group");
  let projects2 = await xata6.db.projects.filter({ group }).getAll();
  return c.json(projects2);
});
projects.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  let project = await xata6.db.projects.filter({ slug }).getFirst();
  return c.json(project);
});
projects.get("/bySkill/:id", async (c) => {
  const skillID = c.req.param("id");
  const skills2 = await xata6.db.projects_skills.filter({ "skill.id": skillID }).select(["project.id", "project.name", "project.group", "project.slug"]).getAll();
  return c.json(skills2);
});
var projects_default = projects;

// src/routes/details.ts
var details = new Hono2;
var xata8 = getXataClient();
details.get("/", async (c) => {
  const details2 = await xata8.db["details"].getAll();
  return c.json(details2);
});
details.get("/contact", (c) => {
  return c.json("get all details");
});
details.get("/profile", (c) => {
  return c.json("get all details");
});
details.get("/:id", (c) => {
  return c.json("get detail by id");
});
var details_default = details;

// src/routes/schools.ts
var xata10 = getXataClient();
var schools = new Hono2;
schools.get("/", async (c) => {
  const results = await xata10.db["schools"].getAll();
  return c.json(results);
});
schools.get("/:id", (c) => {
  return c.json("get schools by id");
});
var schools_default = schools;

// src/routes/content.ts
var xata12 = getXataClient();
var siteContent = new Hono2;
siteContent.get("/:selector", async (c) => {
  const contentBlock = await xata12.db.content.filter({ slug: c.req.param("selector") }).getFirst();
  return c.json(contentBlock);
});
siteContent.get("/group/:selector", async (c) => {
  const contentSet = await xata12.db.content.filter({ group: c.req.param("selector") }).getMany();
  return c.json(contentSet);
});
var content_default = siteContent;

// node_modules/hono/dist/utils/encode.js
var decodeBase64Url = (str) => {
  return decodeBase64(str.replace(/_|-/g, (m) => ({ _: "/", "-": "+" })[m] ?? m));
};
var encodeBase64Url = (buf) => encodeBase64(buf).replace(/\/|\+/g, (m) => ({ "/": "_", "+": "-" })[m] ?? m);
var encodeBase64 = (buf) => {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0, len = bytes.length;i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};
var decodeBase64 = (str) => {
  const binary = atob(str);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  const half = binary.length / 2;
  for (let i = 0, j = binary.length - 1;i <= half; i++, j--) {
    bytes[i] = binary.charCodeAt(i);
    bytes[j] = binary.charCodeAt(j);
  }
  return bytes;
};

// node_modules/hono/dist/utils/jwt/jwa.js
var AlgorithmTypes = ((AlgorithmTypes2) => {
  AlgorithmTypes2["HS256"] = "HS256";
  AlgorithmTypes2["HS384"] = "HS384";
  AlgorithmTypes2["HS512"] = "HS512";
  AlgorithmTypes2["RS256"] = "RS256";
  AlgorithmTypes2["RS384"] = "RS384";
  AlgorithmTypes2["RS512"] = "RS512";
  AlgorithmTypes2["PS256"] = "PS256";
  AlgorithmTypes2["PS384"] = "PS384";
  AlgorithmTypes2["PS512"] = "PS512";
  AlgorithmTypes2["ES256"] = "ES256";
  AlgorithmTypes2["ES384"] = "ES384";
  AlgorithmTypes2["ES512"] = "ES512";
  AlgorithmTypes2["EdDSA"] = "EdDSA";
  return AlgorithmTypes2;
})(AlgorithmTypes || {});

// node_modules/hono/dist/helper/adapter/index.js
var knownUserAgents = {
  deno: "Deno",
  bun: "Bun",
  workerd: "Cloudflare-Workers",
  node: "Node.js"
};
var getRuntimeKey = () => {
  const global = globalThis;
  const userAgentSupported = typeof navigator !== "undefined" && typeof navigator.userAgent === "string";
  if (userAgentSupported) {
    for (const [runtimeKey, userAgent] of Object.entries(knownUserAgents)) {
      if (checkUserAgentEquals(userAgent)) {
        return runtimeKey;
      }
    }
  }
  if (typeof global?.EdgeRuntime === "string") {
    return "edge-light";
  }
  if (global?.fastly !== undefined) {
    return "fastly";
  }
  if (global?.process?.release?.name === "node") {
    return "node";
  }
  return "other";
};
var checkUserAgentEquals = (platform) => {
  const userAgent = navigator.userAgent;
  return userAgent.startsWith(platform);
};

// node_modules/hono/dist/utils/jwt/types.js
var JwtAlgorithmNotImplemented = class extends Error {
  constructor(alg) {
    super(`${alg} is not an implemented algorithm`);
    this.name = "JwtAlgorithmNotImplemented";
  }
};
var JwtTokenInvalid = class extends Error {
  constructor(token) {
    super(`invalid JWT token: ${token}`);
    this.name = "JwtTokenInvalid";
  }
};
var JwtTokenNotBefore = class extends Error {
  constructor(token) {
    super(`token (${token}) is being used before it's valid`);
    this.name = "JwtTokenNotBefore";
  }
};
var JwtTokenExpired = class extends Error {
  constructor(token) {
    super(`token (${token}) expired`);
    this.name = "JwtTokenExpired";
  }
};
var JwtTokenIssuedAt = class extends Error {
  constructor(currentTimestamp, iat) {
    super(`Incorrect "iat" claim must be a older than "${currentTimestamp}" (iat: "${iat}")`);
    this.name = "JwtTokenIssuedAt";
  }
};
var JwtHeaderInvalid = class extends Error {
  constructor(header) {
    super(`jwt header is invalid: ${JSON.stringify(header)}`);
    this.name = "JwtHeaderInvalid";
  }
};
var JwtTokenSignatureMismatched = class extends Error {
  constructor(token) {
    super(`token(${token}) signature mismatched`);
    this.name = "JwtTokenSignatureMismatched";
  }
};
var CryptoKeyUsage = ((CryptoKeyUsage2) => {
  CryptoKeyUsage2["Encrypt"] = "encrypt";
  CryptoKeyUsage2["Decrypt"] = "decrypt";
  CryptoKeyUsage2["Sign"] = "sign";
  CryptoKeyUsage2["Verify"] = "verify";
  CryptoKeyUsage2["DeriveKey"] = "deriveKey";
  CryptoKeyUsage2["DeriveBits"] = "deriveBits";
  CryptoKeyUsage2["WrapKey"] = "wrapKey";
  CryptoKeyUsage2["UnwrapKey"] = "unwrapKey";
  return CryptoKeyUsage2;
})(CryptoKeyUsage || {});

// node_modules/hono/dist/utils/jwt/utf8.js
var utf8Encoder = new TextEncoder;
var utf8Decoder = new TextDecoder;

// node_modules/hono/dist/utils/jwt/jws.js
async function signing(privateKey, alg, data) {
  const algorithm = getKeyAlgorithm(alg);
  const cryptoKey = await importPrivateKey(privateKey, algorithm);
  return await crypto.subtle.sign(algorithm, cryptoKey, data);
}
async function verifying(publicKey, alg, signature, data) {
  const algorithm = getKeyAlgorithm(alg);
  const cryptoKey = await importPublicKey(publicKey, algorithm);
  return await crypto.subtle.verify(algorithm, cryptoKey, signature, data);
}
var pemToBinary = function(pem) {
  return decodeBase64(pem.replace(/-+(BEGIN|END).*/g, "").replace(/\s/g, ""));
};
async function importPrivateKey(key, alg) {
  if (!crypto.subtle || !crypto.subtle.importKey) {
    throw new Error("`crypto.subtle.importKey` is undefined. JWT auth middleware requires it.");
  }
  if (isCryptoKey(key)) {
    if (key.type !== "private") {
      throw new Error(`unexpected non private key: CryptoKey.type is ${key.type}`);
    }
    return key;
  }
  const usages = [CryptoKeyUsage.Sign];
  if (typeof key === "object") {
    return await crypto.subtle.importKey("jwk", key, alg, false, usages);
  }
  if (key.includes("PRIVATE")) {
    return await crypto.subtle.importKey("pkcs8", pemToBinary(key), alg, false, usages);
  }
  return await crypto.subtle.importKey("raw", utf8Encoder.encode(key), alg, false, usages);
}
async function importPublicKey(key, alg) {
  if (!crypto.subtle || !crypto.subtle.importKey) {
    throw new Error("`crypto.subtle.importKey` is undefined. JWT auth middleware requires it.");
  }
  if (isCryptoKey(key)) {
    if (key.type === "public" || key.type === "secret") {
      return key;
    }
    key = await exportPublicJwkFrom(key);
  }
  if (typeof key === "string" && key.includes("PRIVATE")) {
    const privateKey = await crypto.subtle.importKey("pkcs8", pemToBinary(key), alg, true, [
      CryptoKeyUsage.Sign
    ]);
    key = await exportPublicJwkFrom(privateKey);
  }
  const usages = [CryptoKeyUsage.Verify];
  if (typeof key === "object") {
    return await crypto.subtle.importKey("jwk", key, alg, false, usages);
  }
  if (key.includes("PUBLIC")) {
    return await crypto.subtle.importKey("spki", pemToBinary(key), alg, false, usages);
  }
  return await crypto.subtle.importKey("raw", utf8Encoder.encode(key), alg, false, usages);
}
async function exportPublicJwkFrom(privateKey) {
  if (privateKey.type !== "private") {
    throw new Error(`unexpected key type: ${privateKey.type}`);
  }
  if (!privateKey.extractable) {
    throw new Error("unexpected private key is unextractable");
  }
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const { kty } = jwk;
  const { alg, e, n } = jwk;
  const { crv, x, y } = jwk;
  return { kty, alg, e, n, crv, x, y, key_ops: [CryptoKeyUsage.Verify] };
}
var getKeyAlgorithm = function(name) {
  switch (name) {
    case "HS256":
      return {
        name: "HMAC",
        hash: {
          name: "SHA-256"
        }
      };
    case "HS384":
      return {
        name: "HMAC",
        hash: {
          name: "SHA-384"
        }
      };
    case "HS512":
      return {
        name: "HMAC",
        hash: {
          name: "SHA-512"
        }
      };
    case "RS256":
      return {
        name: "RSASSA-PKCS1-v1_5",
        hash: {
          name: "SHA-256"
        }
      };
    case "RS384":
      return {
        name: "RSASSA-PKCS1-v1_5",
        hash: {
          name: "SHA-384"
        }
      };
    case "RS512":
      return {
        name: "RSASSA-PKCS1-v1_5",
        hash: {
          name: "SHA-512"
        }
      };
    case "PS256":
      return {
        name: "RSA-PSS",
        hash: {
          name: "SHA-256"
        },
        saltLength: 32
      };
    case "PS384":
      return {
        name: "RSA-PSS",
        hash: {
          name: "SHA-384"
        },
        saltLength: 48
      };
    case "PS512":
      return {
        name: "RSA-PSS",
        hash: {
          name: "SHA-512"
        },
        saltLength: 64
      };
    case "ES256":
      return {
        name: "ECDSA",
        hash: {
          name: "SHA-256"
        },
        namedCurve: "P-256"
      };
    case "ES384":
      return {
        name: "ECDSA",
        hash: {
          name: "SHA-384"
        },
        namedCurve: "P-384"
      };
    case "ES512":
      return {
        name: "ECDSA",
        hash: {
          name: "SHA-512"
        },
        namedCurve: "P-521"
      };
    case "EdDSA":
      return {
        name: "Ed25519",
        namedCurve: "Ed25519"
      };
    default:
      throw new JwtAlgorithmNotImplemented(name);
  }
};
var isCryptoKey = function(key) {
  const runtime = getRuntimeKey();
  if (runtime === "node" && !!crypto.webcrypto) {
    return key instanceof crypto.webcrypto.CryptoKey;
  }
  return key instanceof CryptoKey;
};

// node_modules/hono/dist/utils/jwt/jwt.js
var isTokenHeader = function(obj) {
  if (typeof obj === "object" && obj !== null) {
    const objWithAlg = obj;
    return "alg" in objWithAlg && Object.values(AlgorithmTypes).includes(objWithAlg.alg) && (!("typ" in objWithAlg) || objWithAlg.typ === "JWT");
  }
  return false;
};
var encodeJwtPart = (part) => encodeBase64Url(utf8Encoder.encode(JSON.stringify(part))).replace(/=/g, "");
var encodeSignaturePart = (buf) => encodeBase64Url(buf).replace(/=/g, "");
var decodeJwtPart = (part) => JSON.parse(utf8Decoder.decode(decodeBase64Url(part)));
var sign = async (payload, privateKey, alg = "HS256") => {
  const encodedPayload = encodeJwtPart(payload);
  const encodedHeader = encodeJwtPart({ alg, typ: "JWT" });
  const partialToken = `${encodedHeader}.${encodedPayload}`;
  const signaturePart = await signing(privateKey, alg, utf8Encoder.encode(partialToken));
  const signature = encodeSignaturePart(signaturePart);
  return `${partialToken}.${signature}`;
};
var verify = async (token, publicKey, alg = "HS256") => {
  const tokenParts = token.split(".");
  if (tokenParts.length !== 3) {
    throw new JwtTokenInvalid(token);
  }
  const { header, payload } = decode(token);
  if (!isTokenHeader(header)) {
    throw new JwtHeaderInvalid(header);
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.nbf && payload.nbf > now) {
    throw new JwtTokenNotBefore(token);
  }
  if (payload.exp && payload.exp <= now) {
    throw new JwtTokenExpired(token);
  }
  if (payload.iat && now < payload.iat) {
    throw new JwtTokenIssuedAt(now, payload.iat);
  }
  const headerPayload = token.substring(0, token.lastIndexOf("."));
  const verified = await verifying(publicKey, alg, decodeBase64Url(tokenParts[2]), utf8Encoder.encode(headerPayload));
  if (!verified) {
    throw new JwtTokenSignatureMismatched(token);
  }
  return payload;
};
var decode = (token) => {
  try {
    const [h, p] = token.split(".");
    const header = decodeJwtPart(h);
    const payload = decodeJwtPart(p);
    return {
      header,
      payload
    };
  } catch (e) {
    throw new JwtTokenInvalid(token);
  }
};

// node_modules/hono/dist/utils/jwt/index.js
var Jwt = { sign, verify, decode };

// node_modules/hono/dist/middleware/jwt/jwt.js
var verify2 = Jwt.verify;
var decode2 = Jwt.decode;
var sign2 = Jwt.sign;

// src/services/auth.service.ts
class AuthService {
  static async HashPassword(password) {
    return await Bun.password.hash(password, {
      algorithm: "argon2id",
      timeCost: 6,
      memoryCost: 6
    });
  }
  static async VerifyPassword(password, hash) {
    return await Bun.password.verify(hash, password);
  }
  static async signToken(userID) {
    return sign2({
      id: userID,
      exp: Math.floor(Date.now() / 1000) + 21600
    }, Bun.env.JWT_SECRET);
  }
  static async verifyToken(token) {
    try {
      await verify2(token, Bun.env.JWT_SECRET);
      return true;
    } catch (error) {
      return false;
    }
  }
}

// src/routes/auth.ts
var xata14 = getXataClient();
var auth = new Hono2;
auth.post("register", async (c) => {
  const body2 = await c.req.json().then((body3) => {
    if (body3.auth != Bun.env.AUTHPASS)
      return;
    AuthService.HashPassword(body3.password).then(async (hashword) => {
      const newUser = await xata14.db.users.create({
        username: body3.username,
        password: hashword,
        firstName: body3.firstName,
        lastName: body3.lastName,
        email: body3.email
      });
      return c.json(newUser);
    });
  });
  return c.json({ response: body2 });
});
auth.post("login", async (c) => {
  const body2 = await c.req.json().then((body3) => {
    const username = body3.username;
    const password = body3.password;
    return xata14.db.users.filter({ username }).getFirst().then((result) => {
      if (result && result.password) {
        return AuthService.VerifyPassword(password, result.password).then((verified) => {
          if (verified) {
            return AuthService.signToken(result.id);
          }
        });
      }
    });
  });
  return c.json({ token: body2 });
});
auth.post("verify", async (c) => {
  const body2 = await c.req.json().then((body3) => {
    const token = body3.token;
    return AuthService.verifyToken(token);
  });
  return c.json({ isVerified: body2 });
});
var auth_default = auth;

// src/index.ts
var app = new Hono2;
app.use("/*", cors());
app.route("/articles", articles_default);
app.route("/skills", skills_default);
app.route("/details", details_default);
app.route("/projects", projects_default);
app.route("/schools", schools_default);
app.route("/content", content_default);
app.route("/auth", auth_default);
var port = process.env.PORT || 3000;
Bun.serve({
  fetch: app.fetch,
  port
});
console.log(`Application is running and listening on port ${port}`);
await Bun.build({
  entrypoints: ["./index.ts"],
  outdir: "./built"
});
