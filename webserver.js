var fs = require('fs');
var path = require('path');
var zipstream = require('zipstream');
var async = require('async');
var QRCode = require('qrcode-npm');
var xpath = require('xpath');
var dom = require('xmldom').DOMParser;
var express = require('express');
var dns = require('dns');
var os = require('os');
var app = express();


/**
 * Features:
 *  - project listing
 *  - on-the-fly compression for packed downloads
 *  - project creation/updating
 *
 * TODO:
 *  - subdir for each project?
 */


app.use(express.logger());

WEBCONTENT_DIR = path.join(__dirname, 'WebContent');
VIEW_DIR = path.join(__dirname, 'views');
PROJECT_DIR = path.join(WEBCONTENT_DIR, 'data');
PORT = parseInt(process.argv[2], 10) || 8888;

// static files
app.use(express.static(WEBCONTENT_DIR));
app.set('views', VIEW_DIR);
app.set('view engine', 'jade');

function readAppPackage(cb) {
	fs.readFile('android_package.json', function (err, data) {
		if (err)
			return cb(err);

		cb(err, JSON.parse(data));
	});
}

function getServerIPs(cb) {
	var interfaces = os.networkInterfaces();
	var addresses = [];
	for (k in interfaces) {
			for (k2 in interfaces[k]) {
					var address = interfaces[k][k2];
					if (address.family == 'IPv4' && !address.internal) {
							addresses.push(address.address)
					}
			}
	}
	console.log('addresses:'+addresses);
	cb(null, addresses);
}

function getServerIP(cb) {
	dns.lookup(os.hostname(), cb);
}

function extractSvgs(xml_file, cb) {
	fs.readFile(xml_file, {encoding: 'utf8'}, function (err, data) {
		if (err) return cb(err);

		var doc = new dom().parseFromString(data);
			var nodes = xpath.select("//svgpath", doc);

		async.map(nodes, function (node, cb) {
			cb(null, node.firstChild.data);
		}, cb);
	});
}

function projectFiles(project, cb) {
	var files = {};
	var xml_file = project+'.xml';

	files.xml = xml_file;

	async.parallel({
		svg: function (cb) {
			extractSvgs(path.join(PROJECT_DIR, xml_file), cb);
		},
		ip: getServerIP,
		ips: getServerIPs
	}, function (err, results) {
		if (err) return cb(err);

		files.svg = results.svg;
		files.zip = 'http://'+results.ip[0]+':'+PORT+'/projects/'+project+'.zip';
		files.zips = [];
		for (var i = 0; i < results.ips.length; i++) {
			files.zips.push('http://'+results.ips[i]+':'+PORT+'/projects/'+project+'.zip');
		}

		cb(null, files);
	});
}

// html + js for android app
app.get('/appupdate/get.zip', function (req, res) {
	readAppPackage(function (err, data) {
		if (err) {
			return res.send(500, err);
		}

		var zip = zipstream.createZip({level: 1});

		res.header('Content-Type', 'application/zip');
		zip.pipe(res);

		async.eachSeries(data.files, function (filename, cb) {
			zip.addFile(fs.createReadStream(path.join(WEBCONTENT_DIR, filename)), {name: filename}, cb);
		}, function () {
			zip.finalize(function (written) {
				console.log("sent "+written+" bytes zipped app package");
			});
		})
	});
});

// project list
app.get('/projects/list.json', function (req, res) {
	fs.readdir(PROJECT_DIR, function (err, files) {
		if (err) {
			console.error(err);
			return res.send(500, err);
		}

		async.filter(files, function (file, cb) {
			cb(path.extname(file) == '.xml')
		}, function (results) {
			res.header('Content-Type', 'application/json');
			res.send(JSON.stringify(results));
		});
	});
});

// file list and download link for project
app.get('/projects/:project/files.json', function (req, res) {
	projectFiles(req.params.project, function (err, files) {
		if (err) {
			console.error(err);
			return res.send(500, err);
		}

		res.header('Content-Type', 'application/json');
		res.send(JSON.stringify(files));
	});
});

// project download
app.get('/projects/:project.zip', function (req, res) {
	var android = req.query.android == 'true';

	projectFiles(req.params.project, function (err, files) {
		if (err) {
			console.error(err);
			return res.send(500, err);
		}

		var zip = zipstream.createZip({level: 1});

		res.header('Content-Type', 'application/zip');
		zip.pipe(res);

		var zipfiles = [];
		zipfiles.push(files.xml);
		Array.prototype.push.apply(zipfiles, files.svg);

		async.eachSeries(zipfiles, function (filename, cb) {
			var zipfilename = filename;
			if (android && filename.split('.').pop() == 'xml') {
				zipfilename = 'project.xml';
			}
			zip.addFile(fs.createReadStream(path.join(PROJECT_DIR, filename)), {name: zipfilename}, cb);
		}, function () {
			zip.finalize(function (written) {
				console.log("sent "+written+" bytes zipped project package");
			});
		})
	});
});

// new project
app.put('/projects/new/:project.xml', function (req, res) {
	if (req.ip != '127.0.0.1') {
		return res.send(403, 'access denied');
	}

	var stream = fs.createWriteStream(path.join(PROJECT_DIR, req.params.project+'.xml'));
	req.pipe(stream);
	stream.on('finish', function () {
		res.send('ok');
	});
	stream.on('error', function () {
		res.send(500, 'error');
	});
});

// upload (and update)
app.put('/projects/:project/upload/:file', function (req, res) {
	if (req.ip != '127.0.0.1') {
		return res.send(403, 'access denied');
	}

	var stream = fs.createWriteStream(path.join(PROJECT_DIR, req.params.file));
	req.pipe(stream);
	stream.on('finish', function () {
		res.send('ok');
	});
	stream.on('error', function () {
		res.send(500, 'error');
	});
});

// index
app.get('/', function (req, res) {
	getServerIPs(function (err, addresses) {
		if (addresses.length == 0) {
			var err = "No network interfaces found!";
			console.error(err);
			return res.send(500, err);
		}
		var qrs = [];
		var apps = [];
		for (var i = 0; i < addresses.length; i++) {
			var ip = addresses[i];
			var applink = 'http://'+ip+':'+PORT+'/appupdate/get.zip'
			var url = 'app,' + applink

			var qr = QRCode.qrcode(4, 'L');
			qr.addData(url);
			qr.make();
			
			var app = {};
			app.qr = qr.createImgTag(5);
			app.applink = applink;
			apps.push(app);
		}
		res.render('index', {apps: apps});
	});
});

console.log('serving at 0.0.0.0:'+PORT);
app.listen(PORT, '0.0.0.0');