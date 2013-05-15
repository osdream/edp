/**
 * @file 内建资源处理方法集合
 * @author otakustay[otakustay@live.com], 
 *         errorrik[errorrik@gmail.com],
 *         ostream[ostream.song@gmail.com]
 */

var fs          = require( 'fs' );
var path        = require( 'path' );
var less        = require( 'less' );
var async       = require( 'async' );
var util        = require( '../util' );
var mimeType    = require( './mimeTypes' );
var baiduJnLess = require( 'baidu-jn-less' );

require( 'colors' );

/**
 * SESSION = {
 *   "request_id" : {
 *     "count" : 3,
 *     "buffer_size" : 0,
 *     "buffer" : [
 *       list<string>,
 *       list<string>,
 *       list<string>,
 *       ...
 *     ]
 *   }
 * }
 * @type {Object}
 */
var SESSION = {};

function log(message) {
    var now = new Date();
    console.log('[' + now.getFullYear()
        + '/' + (now.getMonth() + 1)
        + '/' + now.getDay()
        + ' ' + now.getHours()
        + ':' + now.getMinutes()
        + ':' + now.getSeconds()
        + '] ' + message
    );
}

/**
 * return the file list from the request url.
 * @param {string} query the query.
 * @param {string=} optKey the optional key for the query, default
 *   is 'uris'.
 * @return {Array.<string>}
 */
function getFileList(query, optKey) {
    var key = optKey || 'uris';

    if (!query[key] || query[key].length <= 0) {
        return [];
    }

    var uris = decodeURIComponent(query[key]).split(',');

    var requestId = query['request_id'];
    var index = parseInt(query['index'], 10);
    var count = parseInt(query['count'], 10);

    if (( !! requestId) && (index >= 0) && (count > 0)) {
        // the batch request
        if (!SESSION[requestId]) {
            SESSION[requestId] = {
                'count': count,
                'buffer_size': 0,
                'buffer': []
            };
        }

        var cache = SESSION[requestId];
        if (!cache['buffer'][index]) {
            cache['buffer'][index] = uris;
            cache['buffer_size'] += 1;
        }
        if (cache['count'] == cache['buffer_size']) {
            // the buffer is full, concat all of the uris in the buffer, and
            // return the result to the upper level.
            uris = [];
            cache['buffer'].forEach(function (item) {
                uris = uris.concat(item);
            });

            // clear the cache
            delete SESSION[requestId];

            return uris;
        } else {
            return [];
        }
    } else {
        // the normal request
        return uris;
    }
}

/**
 * @param {Array.<string>} files the request url.
 * @param {string=} optCallback the handler for each file.
 *
 * @return {string} the file contents.
 */
function combineFiles(files, docRoot, optCallback) {
    var defaultCallback = function (file, callback) {
        var absPath = path.normalize(path.join(docRoot, file));
        log('[REQUEST] '.blue + absPath);
        fs.readFile(absPath, callback);
    };
    var callback = optCallback || defaultCallback;

    var validFiles = files.filter(function (item) {
        return !!item;
    });

    var ee = new(require('events').EventEmitter)();
    async.map(validFiles, callback, function (err, results) {
        if (err) {
            ee.emit('error', err);
        } else {
            ee.emit('success', results.join('\n'));
        }
    });
    return ee;
}

/**
 * lauch the less compiler, and generate the
 * *.css file when necessary.
 * @param {string} lessAbsPath the absolute file path.
 * @param {string} css the compiled css code.
 */
function generateCompiledStyles(lessAbsPath, css) {
    var outOfDate = false;
    var absPath = lessAbsPath;
    var compiledCss = absPath.replace(/\.less$/, '.compiled.css');

    if (!fs.existsSync(compiledCss)) {
        outOfDate = true;
    } else {
        var a = Date.parse(fs.statSync(absPath).mtime),
            b = Date.parse(fs.statSync(compiledCss).mtime);
        if (a > b) {
            // *.less was changed again
            outOfDate = true;
        }
    }

    if (outOfDate) {
        // XXX need toString
        fs.writeFile(compiledCss, css, function (err) {
            if (err) {
                throw err;
            }
            log('[REBUILD] '.yellow + compiledCss);
        });
    }
}

/**
 * 把url或者data-uri中的相对路径进行改写。
 * @param {string} code less或者css代码.
 * @param {string} absPath less或者css文件的绝对路径.
 * @param {string} reqPath 请求的文件路径，例如/jn/combine/all.css.
 * @param {string} physicalPath 合并之后的less文件的物理存放地址(用于计算data-uri的相对位置)
 */
function rewriteResourcePath(code, absPath, reqPath, physicalPath) {
    var urlPattern = /(url|data\-uri)\s*\(\s*(['"]?)([^\)'"]+)(\2)\s*\)/g;
    var dirName = path.dirname(absPath);
    var rewritedCode = code.replace(
        urlPattern,
        function(match, p0, p1, p2, p3) {
            if (p2.indexOf('data:') === 0 ||
                p2[0] == '/' ||
                p2.match(/^https?:\/\//g)
            ) {
                return match;
            }
            var url;
            if (p0 === 'url') {
                var resource = path.relative(
                    path.dirname(reqPath),
                    path.normalize(path.join(dirName, p2))
                );
                url = resource.replace(/\\/g, '/');
            }
            else {
                // 如果是data-uri，那么相对的实际上是文件系统的路径，不是/combine/all.css
                // 例如: src/a.less里面有data-uri("../../../a.gif")
                // 由于合并之后文件存储于documentRoot/tmp-xxx.less里，那么图片路径应该是
                // src/../../../a.gif
                var resource = path.relative(
                    path.dirname(physicalPath),
                    path.normalize(path.join(dirName, p2))
                );
                url = resource.replace(/\\/g, '/');
            }
            return p0 + '(' + p1 + url + p3 + ')';
        }
    );
    return rewritedCode;
}

/**
 * 输出
 *
 * @return {Function}
 */
exports.write = function () {
    return function ( context ) {
        var response = context.response;
        var request  = context.request;
        var header   = context.header;
        var extname  = path.extname( request.pathname ).slice( 1 );

        if ( context.status == 200 && !header[ 'Content-Type' ] ) {
            header[ 'Content-Type' ] = mimeType[ extname ];
        }

        response.writeHeader( context.status, context.header );
        context.content && response.write( context.content );
        context.end();
    };
};

/**
 * 列出文件夹内文件
 *
 * @param {string=} dir 文件夹路径
 * @return {Function}
 */
exports.listDirectory = function(dir) {
    return function (context) {
        var docRoot  = context.conf.documentRoot;
        var pathname = context.request.pathname;
        var dirPath = dir || docRoot + pathname;
        var handlebars = require('handlebars');

        context.stop();
        fs.readdir(dirPath, function(err, files) {
            var list = [];
            files.forEach(function(file) {
                var stat = fs.statSync(path.join(dirPath, file));
                list.push({
                    'name': stat.isDirectory() ? file + '/' :  file,
                    'url': encodeURIComponent(file)
                            + (stat.isDirectory() ? '/' : ''),
                    'size': stat.size,
                    'mtime': stat.mtime,
                });
            });

            var templateDir = path.resolve(__dirname, '../scaffold');
            var tplStr = fs.readFileSync(
                path.join(templateDir, 'dirlist.tpl'),
                'utf8'
            );
            var tpl = handlebars.compile(tplStr);
            var html = tpl({
                'files' : list
            });
            context.status = 200;
            context.header[ 'Content-Type' ] = mimeType.html;
            context.content = html;
            context.start();
        });
    };
};

/**
 * 读取文件
 * 
 * @param {string=} file 文件名
 * @return {Function}
 */
exports.file = function ( file ) {
    return function ( context ) {
        var docRoot  = context.conf.documentRoot;
        var pathname = context.request.pathname;
        var filePath = file || docRoot + pathname;

        context.stop();
        fs.stat(filePath, function(error, stats){
            var toStart = true;
            if (!error) {
                if (stats.isDirectory()) {
                    if (!filePath.match(/\/$/)) {
                        context.status = 302;
                        var loc = path.relative(docRoot, filePath);
                        context.header[ 'Location' ] = '/' + loc + '/';
                    }
                    else if (context.conf.directoryIndexes) {
                        exports.listDirectory(filePath)(context);
                        toStart = false;
                    }
                }
                else {
                    var content = fs.readFileSync( filePath );
                    context.content = content;
                }
            }
            else {
                context.status = 404;
            }
            toStart && context.start();
        });
    };
};

/**
 * 主索引页
 * 
 * @param {string|Array} file 索引页文件名
 * @return {Function}
 */
exports.home = function ( file ) {
    return function ( context ) {
        var docRoot  = context.conf.documentRoot;
        var pathname = context.request.pathname;

        var files;
        if ( file instanceof Array ) {
            files = file;
        }
        else if ( typeof file == 'string' ) {
            files = [ file ];
        }

        var isExist = false;
        var dir = docRoot + pathname;
        if ( file ) {
            for ( var i = 0; i < files.length; i++ ) {
                var filePath = dir + files[ i ];
                if ( fs.existsSync( filePath ) ) {
                    var content = fs.readFileSync( filePath );
                    context.content = content;
                    isExist = true;
                    break;
                }
            }
        }

        if (!isExist) {
            if (context.conf.directoryIndexes
                && fs.existsSync(dir)
            ) {
                exports.listDirectory(dir)(context);
            }
            else {
                context.status = 404;
            }
        }
    };
};

/**
 * 设置Content-Type头
 * 
 * @param {string=} contentType contentType
 * @return {Function}
 */
exports.contentType = function ( contentType ) {
    return function ( context ) {
        if ( contentType ) {
            context.header[ 'Content-Type' ] = contentType;
        }
    };
};

/**
 * 设置头
 * 
 * @param {Object} header response头
 * @return {Function}
 */
exports.header = function ( header ) {
    return function ( context ) {
        context.header = util.mix( context.header, header );
    };
};

/**
 * 输出json
 * 
 * @param {JSON} data json数据
 * @return {Function}
 */
exports.json = function ( data ) {
    return function ( context ) {
        context.header[ 'Content-Type' ] = mimeType.json;
        if ( data ) {
            context.content = JSON.stringify( data );
        }
    };
};

/**
 * 输出jsonp
 * 
 * @param {JSON} data json数据
 * @param {string} callbackKey 回调函数的参数名
 * @return {Function}
 */
exports.jsonp = function ( data, callbackKey ) {
    callbackKey = callbackKey || 'callback';

    return function ( context ) {
        var qs     = require( 'querystring' );
        var query  = qs.parse( request.search );
        

        context.header[ 'Content-Type' ] = mimeType.js;
        var fnName  = query[ callbackKey ];
        var content = data ? JSON.stringify( data ) : context.content;
        context.content = fnName + '(' + content + ');';
    };
};

/**
 * 输出请求信息
 * 
 * @return {Function}
 */
exports.dumpRequest = function() {
    return function ( context ) {
        var request = context.request;
        var result = {
            url         : request.url,
            method      : request.method,
            httpVersion : request.httpVersion,
            protocol    : request.protocol,
            host        : request.host,
            auth        : request.auth,
            hostname    : request.hostname,
            port        : request.port,
            search      : request.search,
            hash        : request.hash,
            headers     : request.headers,
            query       : request.query,
            body        : request.bodyBuffer.toString( 'utf8' )
        };

        context.header[ 'Content-Type' ] = mimeType.json;
        context.content = JSON.stringify( result, null, '    ' );
    };
};

/**
 * 推迟输出
 * 
 * @param {number} time 推迟输出时间，单位ms
 * @return {Function}
 */
exports.delay = function ( time ) {
    return function ( context ) {
        context.stop();
        setTimeout(
            function() { 
                context.start();
            },
            time
        );
    };
};

/**
 * 输出内容
 * 
 * @param {string} content 要输出的内容
 * @return {Function}
 */
exports.content = function ( content ) {
    return function ( context ) {
        context.content = content;
    };
};

/**
 * 输出重定向
 * 
 * @param {string} location 重定向地址
 * @param {boolean} permanent 是否永久重定向
 * @return {Function}
 */
exports.redirect = function ( location, permanent ) {
    return function ( context ) {
        context.status = permanent ? 301 : 302;
        context.header[ 'Location' ] = location;
    };
};

/**
 * 输出空内容
 * 
 * @return {Function}
 */
exports.empty = function () {
    return exports.content( '' );
};

/**
 * 处理less输出
 * 
 * @param {string} encoding 源编码方式
 * @return {Function}
 */
exports.less = function ( encoding ) {
    return function ( context ) {
        var docRoot  = context.conf.documentRoot;
        var pathname = context.request.pathname;
        var includePaths = context.conf.lessIncludePaths || [];
        var importPath = docRoot + path.dirname( pathname ).replace( /\/$/, '');
        var paths = [importPath];
        includePaths.forEach(function(pt) {
            paths.push(path.resolve(docRoot, pt));
        });

        // FIXME: baiduJnLess ? generateCompiledStyles ?
        var parser = new( less.Parser )( {
            paths: paths
        } );
        context.stop();

        parser.parse( 
            context.content.toString( encoding || 'utf8' ),
            function ( error, tree ) {
                if ( error ) {
                    context.status = 500;
                }
                else {
                    context.header[ 'Content-Type' ] = mimeType.css;
                    context.content = tree.toCSS();
                }

                context.start();
            }
        );
    };
};

/**
 * 对本地找不到响应的请求，试图从通过代理发起请求
 *
 * @return {Function}
 */
exports.proxyNoneExists = function() {
    return function(context) {
        if (context.status == 404) {
            exports.proxy()(context);
        }
    };
};

/**
 * http代理
 * 
 * @param {string} hostname 主机名，可为域名或ip
 * @param {number=} port 端口，默认80
 * @return {Function}
 */
exports.proxy = function ( hostname, port ) {
    return function ( context ) {
        var request = context.request;
        var proxyMap  = context.conf.proxyMap;
        if (!hostname && !proxyMap) {
            return;
        }
        else if (!hostname) {
            var host = request.headers['host'];
            if (proxyMap[host]) {
                var matched = proxyMap[host].split(':');
                hostname = matched[0];
                port = matched[1] || port;
            }
            else {
                console.log('Can not find matched host for ' + host.red);
            }
        }

        context.stop();

        // build request options
        var reqHeaders = request.headers;
        var reqOptions = {
            hostname   : hostname,
            port       : port || 80,
            method     : request.method,
            path       : request.url,
            headers    : reqHeaders
        };
        var oriHost = reqHeaders.host;
        reqHeaders.host = hostname + ( port ? ':' + port : '' );

        // create request object
        log('Forward request ' + (oriHost + request.url).blue + 
            ' to ' + (reqHeaders.host + request.url).blue
        );
        var http = require( 'http' );
        var req = http.request( reqOptions, function ( res ) {
            var content = [];
            res.on( 'data', function ( chunk ) {
                content.push( chunk );
            } );

            res.on( 'end', function () {
                context.content = Buffer.concat( content );
                context.header = res.headers;
                if ( !res.headers.connection ) {
                    context.header.connection = 'close';
                }
                context.status = res.statusCode;
                context.start();
            } );
        } );

        // send request data
        var buffer = context.request.bodyBuffer;
        buffer && req.write( buffer );
        req.end();
    };
};

/**
 * 用于锦囊合并less和css文件
 * 主要用于解决less调试问题以及IE下对css文件个数的限制问题
 *
 * @return {Function}
 */
exports.jnCombineCss = function () {
    return function (context) {
        var request = context.request;
        var docRoot  = context.conf.documentRoot;
        var filelist = getFileList(request.query);
        if (filelist.length <= 0) {
            return '/** Waiting for next chunk. */';
        }

        function getAbsPath(file) {
            return path.normalize(path.join(docRoot, file));
        }

        context.stop();
        // we need generate an temp file
        var uniqueId = Math.floor(Math.random() * 2147483648).toString(36);
        var tempfile = 'tmp-' + uniqueId + '.less';
        var buffer = [];
        filelist.forEach(function (file) {
            if (!file) {
                return;
            }
            var absPath = getAbsPath(file);
            var stat = fs.statSync(absPath);
            if (stat.isFile()) {
                var code = fs.readFileSync(absPath);
                code = rewriteResourcePath(
                    code.toString(),
                    absPath,
                    getAbsPath('/jn/combine/all.css'),
                    getAbsPath(tempfile)
                );
                buffer.push(code);
            }
        });
        fs.writeFileSync(getAbsPath(tempfile), buffer.join('\n'));

        var ee = new(require('events').EventEmitter)();
        var absPath = getAbsPath(tempfile);
        fs.exists(absPath, function(exists) {
            if (!exists) {
                log('[NOFOUND] '.red + absPath);
                ee.emit('success', '');
                return;
            }
            log('[REQUEST] '.blue + absPath);
            // less file
            fs.readFile(absPath, function (err, input) {
                if (err) {
                    ee.emit('error', err);
                    return;
                }
                var includePaths = context.conf.lessIncludePaths || [];
                var paths = [path.dirname(absPath)];
                includePaths.forEach(function(pt) {
                    paths.push(path.resolve(docRoot, pt));
                });
                var options = {
                    'paths': paths,
                    'filename': absPath
                };
                var parser = new(baiduJnLess.Parser)(options);

                parser.parse(input.toString(), function (e, root) {
                    try {
                        if (e) {
                            ee.emit('error', e);
                        }
                        else {
                            // generate *.compiled.css
                            var css = root.toCSS(options);
                            ee.emit('success', css);
                            // delete the temp file
                            fs.unlink(absPath, function (e) {
                                if (e) {
                                    throw e;
                                }
                            });
                        }
                    } catch (x) {
                        ee.emit('error', x);
                    }
                });
            });
        });
        ee.addListener('error', function(err) {
            log('[LESS ERROR] '.red + JSON.stringify(err));
            context.status = 500;
            context.content = '';
            context.start();
        });
        ee.addListener('success', function(result) {
            context.status = 200;
            context.content = result;
            context.start();
        });
    };
};

/**
 * 用于锦囊合并er模板文件
 *
 * @return {Function}
 */
exports.jnCombineTpl = function () {
    return function (context) {
        var request = context.request;
        var docRoot  = context.conf.documentRoot;
        context.stop();
        var ee = combineFiles(getFileList(request.query), docRoot);
        ee.addListener('error', function(err) {
            log('[LESS ERROR] '.red + JSON.stringify(err));
            context.status = 500;
            context.content = '';
            context.start();
        });
        ee.addListener('success', function(result) {
            context.status = 200;
            context.content = result;
            context.start();
        });
    };
};

