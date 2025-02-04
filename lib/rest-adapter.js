// Copyright IBM Corp. 2013,2018. All Rights Reserved.
// Node module: strong-remoting
// This file is licensed under the Artistic License 2.0.
// License text available at https://opensource.org/licenses/Artistic-2.0

'use strict';

const g = require('strong-globalize')();
/*!
 * Expose `RestAdapter`.
 */
module.exports = RestAdapter;

RestAdapter.RestClass = RestClass;
RestAdapter.RestMethod = RestMethod;

/*!
 * Module dependencies.
 */

const deprecated = require('depd')('strong-remoting');
const EventEmitter = require('events').EventEmitter;
const debug = require('debug')('strong-remoting:rest-adapter');
const util = require('util');
const inherits = util.inherits;
const assert = require('assert');
const express = require('express');
const bodyParser = require('body-parser');
const async = require('async');
const HttpInvocation = require('./http-invocation');
const HttpContext = require('./http-context');
const strongErrorHandler = require('strong-error-handler');
const inflection = require('inflection');

const json = bodyParser.json;
const urlencoded = bodyParser.urlencoded;
/**
 * Create a new `RestAdapter` with the given `options`.
 *
 * @param {Object} [options] REST options, default to `remotes.options.rest`.
 * @return {RestAdapter}
 */

function RestAdapter(remotes, options) {
  EventEmitter.call(this);

  this.remotes = remotes;
  this.Context = HttpContext;
  this.options = options || (remotes.options || {}).rest || {};
  this.typeRegistry = remotes._typeRegistry;
}

/**
 * Inherit from `EventEmitter`.
 */

inherits(RestAdapter, EventEmitter);

/*!
 * Simplified APIs
 */

RestAdapter.create =
RestAdapter.createRestAdapter = function(remotes) {
  // add simplified construction / sugar here
  return new RestAdapter(remotes);
};

/**
 * Get the path for the given method.
 */

RestAdapter.prototype.getRoutes = function(obj) {
  return getRoutes(obj, this.options);
};

function getRoutes(obj, options) {
  let routes = obj.http;
  if (routes && !Array.isArray(routes)) {
    routes = [routes];
  }

  // Options of obj (e.g. sharedClass) take precedence over options of adapter
  const sharedClass = obj.sharedClass || obj;
  const classOptions = sharedClass.options;
  let normalize = classOptions && classOptions.normalizeHttpPath;
  if (normalize === undefined && options) {
    normalize = options.normalizeHttpPath;
  }
  const toPath = normalize ? normalizeHttpPath : untransformedPath;

  // overridden
  if (routes) {
    // patch missing verbs / routes
    routes.forEach(function(r) {
      r.verb = String(r.verb || 'all').toLowerCase();
      r.path = toPath(r.path || ('/' + obj.name));
    });
  } else {
    if (obj.name === 'sharedCtor') {
      routes = [{
        verb: 'all',
        path: '/prototype',
      }];
    } else {
      // build default route
      routes = [{
        verb: 'all',
        path: obj.name ? toPath('/' + obj.name) : '',
      }];
    }
  }

  return routes;
}

/**
 * Normalize HTTP path.
 */
function normalizeHttpPath(path) {
  if (typeof path !== 'string') return;
  return path.replace(/[^\/]+/g, function(match) {
    if (match.indexOf(':') > -1) return match; // skip placeholders
    return inflection.transform(match, ['underscore', 'dasherize']);
  });
}

function untransformedPath(path) {
  return path;
}

RestAdapter.prototype.connect = function(url) {
  this.connection = url;
};

/**
 *
 * Get the authorization to use when invoking a remote method.
 *
 * @param {Object} invocationOptions The value of the "options" argument
 *   of the invoked method
 * @private
 */
RestAdapter.prototype._getInvocationAuth = function(invocationOptions) {
  const auth = this.remotes.auth;
  if (auth || !this.options.passAccessToken) {
    // Use the globally-configured authentication credentials
    return auth;
  }

  // Check the `options` argument provided by the caller of the invoked method
  // It may have the access token that can be used
  const accessToken = invocationOptions && invocationOptions.accessToken;
  if (accessToken) {
    return {accessToken};
  }

  // No authentication credentials are configured.
  return undefined;
};

RestAdapter.prototype.invoke = function(method, ctorArgs, args, callback) {
  assert(this.connection,
    g.f('Cannot invoke method without a connection. See {{RemoteObjects#connect().}}'));
  assert(typeof method === 'string', g.f('method is required when calling {{invoke()}}'));

  const lastArg = arguments[arguments.length - 1];
  callback = typeof lastArg === 'function' ? lastArg : undefined;

  ctorArgs = Array.isArray(ctorArgs) ? ctorArgs : [];
  if (!Array.isArray(args)) {
    args = ctorArgs;
    ctorArgs = [];
  }

  const remotes = this.remotes;
  const restMethod = this.getRestMethodByName(method);
  if (!restMethod) {
    return callback(new Error(g.f('Cannot invoke unkown method: %s', method)));
  }
  const invokeOptions = restMethod.getArgByName('options', args);
  const auth = this._getInvocationAuth(invokeOptions);

  const invocation = new HttpInvocation(
    restMethod, ctorArgs, args, this.connection, auth, this.typeRegistry
  );
  const ctx = invocation.context;
  ctx.req = invocation.createRequest();
  const scope = ctx.getScope();
  remotes.execHooks('before', restMethod, scope, ctx, function(err) {
    if (err) { return callback(err); }
    invocation.invoke(function(err) {
      if (err) { return callback(err); }
      const args = Array.prototype.slice.call(arguments);

      ctx.result = args.slice(1);
      ctx.res = invocation.getResponse();
      remotes.execHooks('after', restMethod, scope, ctx, function(err) {
        if (err) { return callback(err); }
        callback.apply(invocation, args);
      });
    });
  });
};

/**
 * creates the rest method by name cache map.
 * @returns {Object} map of rest method name to rest method
 */
RestAdapter.prototype._createRestMethodByNameCache = function() {
  const restMethodByNameMap = {};
  const classes = this.getClasses();
  for (let i = 0; i < classes.length; i++) {
    const restClass = classes[i];
    for (let j = 0; j < restClass.methods.length; j++) {
      const restMethod = restClass.methods[j];
      restMethodByNameMap[restMethod.fullName] = restMethod;
    }
  }
  return restMethodByNameMap;
};

RestAdapter.prototype.getRestMethodByName = function(name) {
  let ret;
  if (this._cachedRestMethodsByName) {
    ret = this._cachedRestMethodsByName[name];
  }

  if (!ret) {
    // Either the method was not found or the cache was not built yet
    // If the method was not found, then let's rebuild the cache
    // to see if there were any new methods added
    this._cachedRestMethodsByName = this._createRestMethodByNameCache();
    ret = this._cachedRestMethodsByName[name];
  }

  if (ret && !ret.sharedMethod.sharedClass.isMethodEnabled(ret.sharedMethod)) {
    // The method was disabled after our cache was built
    ret = undefined;
  }

  return ret;
};

/*!
 * Compare two routes
 * @param {Object} r1 The first route {route: {verb: 'get', path: '/:id'}, method: ...}
 * @param [Object} r2 The second route route: {verb: 'get', path: '/findOne'}, method: ...}
 * @returns {number} 1: r1 comes after 2, -1: r1 comes before r2, 0: equal
 */
function sortRoutes(r1, r2) {
  const a = r1.route;
  const b = r2.route;

  // Normalize the verbs
  let verb1 = a.verb.toLowerCase();
  let verb2 = b.verb.toLowerCase();

  if (verb1 === 'del') {
    verb1 = 'delete';
  }
  if (verb2 === 'del') {
    verb2 = 'delete';
  }
  // First sort by verb
  if (verb1 > verb2) {
    return -1;
  } else if (verb1 < verb2) {
    return 1;
  }

  // Sort by path part by part using the / delimiter
  // For example '/:id' will become ['', ':id'], '/findOne' will become
  // ['', 'findOne']
  const p1 = a.path.split('/');
  const p2 = b.path.split('/');
  const len = Math.min(p1.length, p2.length);

  // Loop through the parts and decide which path should come first
  for (let i = 0; i < len; i++) {
    // Empty part has lower weight
    if (p1[i] === '' && p2[i] !== '') {
      return 1;
    } else if (p1[i] !== '' && p2[i] === '') {
      return -1;
    }
    // Wildcard has lower weight
    if (p1[i][0] === ':' && p2[i][0] !== ':') {
      return 1;
    } else if (p1[i][0] !== ':' && p2[i][0] === ':') {
      return -1;
    }
    // Now the regular string comparision
    if (p1[i] > p2[i]) {
      return 1;
    } else if (p1[i] < p2[i]) {
      return -1;
    }
  }
  // Both paths have the common parts. The longer one should come before the
  // shorter one
  return p2.length - p1.length;
}

RestAdapter.sortRoutes = sortRoutes; // For testing

RestAdapter.prototype.createHandler = function() {
  const corsOptions = this.remotes.options.cors;
  if (corsOptions !== undefined && corsOptions !== false) {
    throw new Error(g.f(
      'The REST adapter no longer comes with a built-in CORS middleware, ' +
        'the config option %j is no longer available.' +
        'See %s for more details.',
      'remoting.cors',
      'https://docs.strongloop.com/display/public/LB/Security+considerations'
    ));
  }

  const root = express.Router();
  const adapter = this;
  const classes = this.getClasses();

  // Add a handler to tolerate empty json as connect's json middleware throws an error
  root.use(function(req, res, next) {
    if (req.is('application/json')) {
      if (req.get('Content-Length') === '0') {
        // This doesn't cover the transfer-encoding: chunked
        req._body = true; // Mark it as parsed
        req.body = {};
      }
    }
    next();
  });

  // Set strict to be `false` so that anything `JSON.parse()` accepts will be parsed
  debug('remoting options: %j', this.remotes.options);
  const urlencodedOptions = this.remotes.options.urlencoded || {extended: true};
  if (urlencodedOptions.extended === undefined) {
    urlencodedOptions.extended = true;
  }
  const jsonOptions = this.remotes.options.json || {strict: false};

  root.use(urlencoded(urlencodedOptions));
  root.use(json(jsonOptions));

  const handleUnknownPaths = this._shouldHandleUnknownPaths();

  classes.forEach(function(restClass) {
    const router = express.Router();
    const className = restClass.sharedClass.name;

    debug('registering REST handler for class %j', className);

    const methods = [];
    // Register handlers for all shared methods of this class sharedClass
    restClass
      .methods
      .forEach(function(restMethod) {
        const sharedMethod = restMethod.sharedMethod;
        debug('    method %s', sharedMethod.stringName);
        restMethod.routes.forEach(function(route) {
          methods.push({route: route, method: sharedMethod});
        });
      });

    // Sort all methods based on the route path
    methods.sort(sortRoutes);

    methods.forEach(function(m) {
      adapter._registerMethodRouteHandlers(router, m.method, m.route);
    });

    if (handleUnknownPaths) {
      // Convert requests for unknown methods of this sharedClass into 404.
      // Do not allow other middleware to invade our URL space.
      router.use(RestAdapter.remoteMethodNotFoundHandler(className));
    }

    // Mount the remoteClass router on all class routes.
    restClass
      .routes
      .forEach(function(route) {
        debug('    at %s', route.path);
        root.use(route.path, router);
      });
  });

  if (handleUnknownPaths) {
    // Convert requests for unknown URLs into 404.
    // Do not allow other middleware to invade our URL space.
    root.use(RestAdapter.urlNotFoundHandler());
  }

  if (this._shouldHandleErrors()) {
    // Use our own error handler to make sure the error response has
    // always the format expected by remoting clients.
    root.use(RestAdapter.errorHandler(this.remotes.options.errorHandler));
  }

  return root;
};

RestAdapter.prototype._shouldHandleUnknownPaths = function() {
  return !(this.options && this.options.handleUnknownPaths === false);
};

RestAdapter.prototype._shouldHandleErrors = function() {
  return !(this.options && this.options.handleErrors === false);
};

RestAdapter.remoteMethodNotFoundHandler = function(className) {
  className = className || '(unknown)';
  return function restRemoteMethodNotFound(req, res, next) {
    const message = g.f('{{Shared class}} \"%s\" has no method handling %s %s',
      className, req.method, req.url);
    const error = new Error(message);
    error.statusCode = 404;
    next(error);
  };
};

RestAdapter.urlNotFoundHandler = function() {
  return function restUrlNotFound(req, res, next) {
    const message = g.f('There is no method to handle %s %s', req.method, req.url);
    const error = new Error(message);
    error.statusCode = 404;
    next(error);
  };
};

RestAdapter.errorHandler = function(options) {
  options = options || {};
  if (options.hasOwnProperty('disableStackTrace')) {
    g.warn(
      '{{strong-remoting}} no longer supports ' +
      '"{{errorHandler.disableStackTrace}}" option. ' +
      'Use the new option "{{errorHandler.debug}}" instead.'
    );
  }

  const strongErrorHandlerInstance = strongErrorHandler(options);

  return function restErrorHandler(err, req, res, next) {
    if (typeof options.handler === 'function') {
      try {
        options.handler(err, req, res, defaultHandler);
      } catch (e) {
        defaultHandler(e);
      }
    } else {
      return defaultHandler();
    }

    function defaultHandler(handlerError) {
      if (handlerError) {
        // ensure errors that occurred during
        // the handler are reported
        err = handlerError;
      }
      return strongErrorHandlerInstance(err, req, res, next);
    }
  };
};

RestAdapter.prototype._registerMethodRouteHandlers = function(router,
  sharedMethod,
  route) {
  const handler = sharedMethod.isStatic ?
    this._createStaticMethodHandler(sharedMethod) :
    this._createPrototypeMethodHandler(sharedMethod);

  debug('        %s %s %s', route.verb, route.path, handler.name);
  let verb = route.verb;
  if (verb === 'del') {
    // Express 4.x only supports delete
    verb = 'delete';
  }
  router[verb](route.path, handler);
};

RestAdapter.prototype._createStaticMethodHandler = function(sharedMethod) {
  const self = this;
  const Context = this.Context;

  return function restStaticMethodHandler(req, res, next) {
    const ctx = new Context(req, res, sharedMethod, self.options, self.typeRegistry);
    self._invokeMethod(ctx, sharedMethod, next);
  };
};

RestAdapter.prototype._createPrototypeMethodHandler = function(sharedMethod) {
  const self = this;
  const Context = this.Context;

  return function restPrototypeMethodHandler(req, res, next) {
    const ctx = new Context(req, res, sharedMethod, self.options, self.typeRegistry);

    // invoke the shared constructor to get an instance
    ctx.invoke(sharedMethod.ctor, sharedMethod.sharedCtor, function(err, inst) {
      if (err) {
        // Defer handling of this error until the request is authorized.
        // The error handler is in RemotObjects.prototype._setupPhase
        // TODO(bajtos) refactor this code so that sharedCtor is invoked
        // from "invokeMethodInContext" too, see #315
        ctx.sharedCtorError = err;
      } else {
        ctx.instance = inst;
      }
      self._invokeMethod(ctx, sharedMethod, next);
    }, true);
  };
};

RestAdapter.prototype._invokeMethod = function(ctx, method, next) {
  const remotes = this.remotes;
  const steps = [];

  if (method.rest.before) {
    steps.push(function invokeRestBefore(cb) {
      debug('Invoking rest.before for ' + ctx.methodString);
      method.rest.before.call(ctx.getScope(), ctx, cb);
    });
  }

  steps.push(
    this.remotes.invokeMethodInContext.bind(this.remotes, ctx)
  );

  if (method.rest.after) {
    steps.push(function invokeRestAfter(cb) {
      debug('Invoking rest.after for ' + ctx.methodString);
      method.rest.after.call(ctx.getScope(), ctx, cb);
    });
  }

  async.series(
    steps,
    function(err) {
      if (err) return next(err);
      ctx.done(function(err) {
        if (err) return next(err);
        // otherwise do not call next middleware
        // the request is handled
      });
    }
  );
};

RestAdapter.prototype.allRoutes = function() {
  const routes = [];
  const adapter = this;
  const classes = this.remotes.classes(this.options);
  let currentRoot = '';

  classes.forEach(function(sc) {
    adapter
      .getRoutes(sc)
      .forEach(function(classRoute) {
        currentRoot = classRoute.path;
        const methods = sc.methods();

        methods.forEach(function(method) {
          adapter.getRoutes(method).forEach(function(route) {
            if (method.isStatic) {
              addRoute(route.verb, route.path, method);
            } else {
              adapter
                .getRoutes(method.sharedCtor)
                .forEach(function(sharedCtorRoute) {
                  addRoute(route.verb, sharedCtorRoute.path + route.path, method);
                });
            }
          });
        });
      });
  });

  return routes;

  function addRoute(verb, path, method) {
    if (path === '/' || path === '//') {
      path = currentRoot;
    } else {
      path = currentRoot + path;
    }

    if (path[path.length - 1] === '/') {
      path = path.substr(0, path.length - 1);
    }

    // TODO this could be cleaner
    path = path.replace(/\/\//g, '/');

    routes.push({
      verb: verb,
      path: path,
      description: method.description,
      notes: method.notes,
      documented: method.documented,
      method: method.stringName,
      accepts: (method.accepts && method.accepts.length) ? method.accepts : undefined,
      returns: (method.returns && method.returns.length) ? method.returns : undefined,
      errors: (method.errors && method.errors.length) ? method.errors : undefined,
    });
  }
};

RestAdapter.prototype.getClasses = function() {
  return this.remotes.classes(this.options).map(c => {
    return new RestClass(c, this.options);
  });
};

function RestClass(sharedClass, adapterOptions) {
  nonEnumerableConstPropery(this, 'sharedClass', sharedClass);

  this.name = sharedClass.name;
  this.options = adapterOptions;
  this.routes = getRoutes(sharedClass, this.options);

  this.ctor = sharedClass.sharedCtor &&
    new RestMethod(this, sharedClass.sharedCtor);

  this.methods = sharedClass.methods()
    .filter(function(sm) { return !sm.isSharedCtor; })
    .map(function(sm) {
      return new RestMethod(this, sm);
    }.bind(this));
}

RestClass.prototype.getPath = function() {
  return this.routes[0].path;
};

function RestMethod(restClass, sharedMethod) {
  nonEnumerableConstPropery(this, 'restClass', restClass);
  nonEnumerableConstPropery(this, 'sharedMethod', sharedMethod);

  // The full name is ClassName.methodName or ClassName.prototype.methodName
  this.fullName = sharedMethod.stringName;
  this.name = this.fullName.split('.').slice(1).join('.');

  this.accepts = sharedMethod.accepts;
  this.returns = sharedMethod.returns;
  this.errors = sharedMethod.errors;
  this.description = sharedMethod.description;
  this.notes = sharedMethod.notes;
  this.documented = sharedMethod.documented;

  const methodRoutes = getRoutes(sharedMethod, restClass.options);
  if (sharedMethod.isStatic || !restClass.ctor) {
    this.routes = methodRoutes;
  } else {
    const routes = this.routes = [];
    methodRoutes.forEach(function(route) {
      restClass.ctor.routes.forEach(function(ctorRoute) {
        const fullRoute = util._extend({}, route);
        fullRoute.path = joinPaths(ctorRoute.path, route.path);
        routes.push(fullRoute);
      });
    });
  }
}

/**
 * Get the argument from the invoked arg array by arg name.
 * @param argName the name of the arg to lookup
 * @param invokedArgs array
 * @returns {*} the arg value or undefined if not found
 */
RestMethod.prototype.getArgByName = function(argName, invokedArgs) {
  let argValue;
  if (!this.accepts || !this.accepts.length) return undefined;
  this.accepts.some(function(argProperty, i) {
    if (argProperty.arg && argProperty.arg.toLowerCase() === argName.toLowerCase()) {
      argValue = invokedArgs[i];
      return true;
    }
    return false;
  });
  return argValue;
};

RestMethod.prototype.isReturningArray = function() {
  return this.returns.length == 1 &&
    this.returns[0].root &&
    getTypeString(this.returns[0].type) === 'array' || false;
};

RestMethod.prototype.acceptsSingleBodyArgument = function() {
  if (this.accepts.length != 1) return false;
  const accepts = this.accepts[0];

  return accepts.http &&
    accepts.http.source == 'body' &&
    getTypeString(accepts.type) == 'object' || false;
};

RestMethod.prototype.getEndpoints = function() {
  const self = this;
  return this.routes.map(function(route) {
    let verbResult;
    const verb = route.verb;
    if (verb == 'all') {
      verbResult = 'POST';
    } else if (verb == 'del') {
      verbResult = 'DELETE';
    } else {
      verbResult = verb.toUpperCase();
    }
    return {
      verb: verbResult,
      fullPath: joinPaths(self.restClass.getPath(), route.path),
    };
  });
};

RestMethod.prototype.getHttpMethod = function() {
  // deprecate message to let the users know what they were using
  // was retuning just the first route's verb
  deprecated('getHttpMethod() is deprecated, use getEndpoints()[0].verb instead.');
  return this.getEndpoints()[0].verb;
};

RestMethod.prototype.getPath = function() {
  return this.routes[0].path;
};

RestMethod.prototype.getFullPath = function() {
  // deprecate message to let the users know what they were using
  // was retuning just the first route's path
  deprecated('getFullPath() is deprecated, use getEndpoints()[0].fullPath instead.');
  return this.getEndpoints()[0].fullPath;
};

function getTypeString(ctorOrName) {
  if (typeof ctorOrName === 'function')
    ctorOrName = ctorOrName.name;
  if (typeof ctorOrName === 'string') {
    return ctorOrName.toLowerCase();
  } else if (Array.isArray(ctorOrName)) {
    return 'array';
  } else {
    debug('WARNING: unkown ctorOrName of type %s: %j',
      typeof ctorOrName, ctorOrName);
    return typeof undefined;
  }
}

function nonEnumerableConstPropery(object, name, value) {
  Object.defineProperty(object, name, {
    value: value,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

function joinPaths(left, right) {
  if (!left) return right;
  if (!right || right == '/') return left;

  const glue = left[left.length - 1] + right[0];
  if (glue == '//')
    return left + right.slice(1);
  else if (glue[0] == '/' || glue[1] == '/')
    return left + right;
  else
    return left + '/' + right;
}
