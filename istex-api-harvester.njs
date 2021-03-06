#!/usr/bin/env node

var program   = require('commander');
var request   = require('superagent');
var uuid      = require('uuid');
var fs        = require('fs');
var mkdirp    = require('mkdirp');
var async     = require('async');
var prompt    = require('prompt');
var path      = require('path');
var package   = require('./package.json');

program
  .version(package.version)
  .option('-q, --query [requete]',     "La requete (?q=) ", '*')
  .option('-c, --corpus [corpus]',     "Le corpus souhaité (ex: springer, ecco, ...)", 'istex')
  .option('-s, --size [size]',         "Quantité de documents à télécharger", 10)
  .option('-m, --metadata [formats]', "Pour retourner seulement certain formats de metadata (ex: mods,xml)", "all")
  .option('-f, --fulltext [formats]', "Pour retourner seulement certain formats de plein text (ex: tei,pdf)", "")
  .option('-u, --username [username]', "Nom d'utilisateur ISTEX", '')
  .option('-p, --password [password]', "Mot de passe ISTEX", '')
  .option('-v, --verbose',             "Affiche plus d'informations", false)
  .option('-S, --spread',              "ventile des fichiers téléchargés dans une arborescence à 3 niveaux", false)
  .option('-H, --host [host:port]',    "interrogation sur un hostname (ou @IP) particulier", "")
  .option('-b, --sortby [sortMode]',             "tri sur un ou plusieurs champ", "")
  .option('-o, --output [outputDir]',             "répertoire de destination (output ou nom de corpus si précisé)","output")
  .parse(process.argv);


var prefixUrl = (program.host !== "") ? "http://" + program.host : "https://api.istex.fr";

var dstPath = path.join(process.cwd(), program.output);
mkdirp.sync(dstPath);
var zipName = path.join(process.cwd(), uuid.v1() + '.zip');

var randomSeed = (new Date()).getTime();

// les paramètres metadata et fulltext peuvent contenir
// une liste de valeurs séparées par des virgules
program.metadata = program.metadata.split(',');
program.fulltext = program.fulltext.split(',');

// découpe le téléchargement par pages
// pour éviter de faire une énorme requête
var nbHitPerPage = 100;
var nbPages      = Math.floor(program.size / nbHitPerPage);
var nbLastPage   = program.size - (nbPages * nbHitPerPage);
var ranges       = [];
for (var page = 0; page < nbPages; page++) {
  ranges.push([ page * nbHitPerPage,  nbHitPerPage]);
};
ranges.push([ nbPages * nbHitPerPage, nbLastPage ]);

// paramétrage de l'éventuel proxy http sortant
// en passant par la variable d'environnement http_proxy
require('superagent-proxy')(request);
var httpProxy = process.env.http_proxy || '';
function prepareHttpGetRequest(url) {
  var agent = request.agent();
  return httpProxy ? agent.get(url).proxy(httpProxy) : agent.get(url);
}

// lance les recherches et les téléchargements
console.log("Téléchargement des " + program.size +
            " premiers documents (metadata & fulltext) ici : " + dstPath);

/**
 * Point d'entrée
 * - vérifie si authentification nécessaire
 * - demande le login/password si nécessaire
 * - lance le téléchargement
 */
checkIfAuthNeeded(function (err, needAuth) {
  if (err) return console.error(err);
  if (needAuth) {
    askLoginPassword(downloadPages);
  } else {
    downloadPages();
  }
});

/**
 * Fonction de téléchargement page par page
 */
function downloadPages() {
  var firstPage = true;
  async.mapLimit(ranges, 1, function (range, cb) {
    downloadPage(range, cb, function (body) {
      if (firstPage) {
        console.log("Nombre de documents dans le corpus " + program.corpus + " : " + body.total);
        firstPage = false;
      }
      console.log('Téléchargement de la page ' +
                  (range[0] / nbHitPerPage +1 ) + ' (' + (range[0] + range[1]) + ' documents)');
    });
  }, function (err) {
    if (err) return console.error(err);
    console.log('Téléchargements terminés');
  });
}

//
// Fonction de téléchargement d'une page
//  
function downloadPage(range, cb, cbBody) {
  var url = prefixUrl + '/document/?q='+program.query+'&output=metadata'
            + (program.fulltext.length != 0 ? ',fulltext' : '')
            + ((program.corpus == 'istex') ? '' : ('&corpus=' + program.corpus))
            + '&from=' + range[0] + '&size=' + range[1];

  if (program.sortby !== "") url += '&sortBy=' + program.sortby;
  if (program.sortby == "random") url += '&randomSeed=' + randomSeed;

  // to ignore bad https certificate
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  prepareHttpGetRequest(url)
  .auth(program.username, program.password)
  .end(function (err, res) {
    if (err) {
      return cb(new Error(err));
    }
    if (!res || !res.body || !res.body.hits) {
      return cb(new Error('Response error: statusCode=' + res.statusCode));
    }

    // transmission du body pour les messages
    cbBody(res.body);

    // lancement des téléchargement de façon séquentielle
    async.mapLimit(res.body.hits, 1, function (item1, cb2) {

      var downloadFn = [];

      // récupération de la liste des opérations
      // de téléchargement des métadonnées
      item1.metadata.forEach(function (meta) {
        
        // ignore les medadonnées non souhaitées
        if (program.metadata.indexOf(meta.extension) !== -1 || program.metadata.indexOf('all') !== -1) {
          // ajoute une opération de téléchargement
          // pour chaque métadonnées souhaitées
          downloadFn.push(function (callback) {
            if (program.verbose) {            
              console.log(meta);
            }
            // ventilation dans une arborescence à 3 niveaux
            var subFolders = (program.spread) ? path.join(item1.id[0], item1.id[1], item1.id[2]) : "" ; 
            mkdirp(path.join(dstPath,subFolders), function(err) {
              if (err) {
                console("Error creating directory " + path.join(dstPath,subFolders) );
                callback(err);
              } 
              var stream = fs.createWriteStream(path.join(
                            dstPath,
                            subFolders,
                            item1.id + '.metadata.' 
                              + (meta.original ? 'original.' : '')
                              + (meta.mimetype.indexOf(meta.extension) === -1 ? '.' + meta.extension + '.' : '')
                              + meta.mimetype.split('/').pop().replace('+', '.')));
              var req = prepareHttpGetRequest(meta.uri).auth(program.username, program.password);
              req.pipe(stream);
              stream.on('finish', function () {
                callback(null);
              });
              stream.on('error', callback);
            });
          });
        }
      });

      // récupération de la liste des opérations
      // de téléchargement des pleins textes
      item1.fulltext.forEach(function (ft) {
        
        // ignore les medadonnées non souhaitées
        if (program.fulltext.indexOf(ft.extension) !== -1 || program.fulltext.indexOf('all') !== -1) {
          // ajoute une opération de téléchargement
          // pour chaque plein texte souhaités
          downloadFn.push(function (callback) {
            if (program.verbose) {            
              console.log(ft);
            }
            // cas particuliers pour les tiff qui sont en fait des zip
            if (ft.mimetype == 'image/tiff') {
              ft.mimetype = 'application/zip';
            }
            // ventilation dans une arborescence à 3 niveaux
            var subFolders = (program.spread) ? path.join(item1.id[0], item1.id[1], item1.id[2]) : "" ; 
            mkdirp(path.join(dstPath,subFolders), function(err) {
              if (err) {
                console("Error creating directory " + path.join(dstPath,subFolders) );
                callback(err);
              } 

              var stream = fs.createWriteStream(path.join(
                            dstPath,
                            subFolders,
                            item1.id + '.fulltext.'
                              + (ft.original ? 'original.' : '')
                              + (ft.mimetype.indexOf(ft.extension) === -1 ? ft.extension + '.' : '')
                              + ft.mimetype.split('/').pop().replace('+', '.')));
              var req = request.get(ft.uri).auth(program.username, program.password);
              req.pipe(stream);
              stream.on('finish', function () {
                callback(null);
              });
              stream.on('error', callback);
            });
          }) 
        }
      });

      // download the metadata and the fulltext
      async.series(downloadFn, function (err) {
        // MODS and fulltext downloaded
        process.stdout.write('.');
        cb2(err);
      });

    }, function (err) {
      console.log('');
      // page downloaded
      cb(err, res.body);
    });

  });
}



/**
 * Tentative de connexion à l'API pour vérifier si
 * on a besoin d'indiquer des identifiants de connexion
 */
function checkIfAuthNeeded(cb) {
  var url = prefixUrl + '/auth'; // document protégé
  prepareHttpGetRequest(url)
    .auth(program.username, program.password)
    .end(function (err, res) {
      if (err) {
        return cb(new Error(err));
      }
      if (res.status !== 200) {
        return cb(null, true);
      } else {
        return cb(null, false);
      }
    });
}

/**
 * Demande à l'utilisateur ses identifiants
 * et test si ils fonctionnent.
 */
function askLoginPassword(cb) {
  // affiche un prompt pour demander si nécessaire à l'utilisateur 
  // d'entrer un login et mot de passe ISTEX
  prompt.message   = '';
  prompt.delimiter = '';
  prompt.start();
  prompt.get({
    properties: {
      username: {
        description: "Nom d'utilisateur ISTEX :",
        default: program.username,
        required: true
      },
      password: {
        description: "Mot de passe ISTEX :",
        default: program.password,
        hidden: true,
        required: true
      }
    }
  }, function (err, results) {
    if (err) return cb(err);
    
    // then try to auth
    program.username = results.username;
    program.password = results.password;
    var url = prefixUrl + '/corpus/';
    prepareHttpGetRequest(url)
      .auth(program.username, program.password)
      .end(function (err, res) {
        if (err) {
          return cb(new Error(err));
        }
        if (res.status !== 200) {
          // souci d'authentification, on relance le prompt
          console.log('[' + res.status + '] ' + res.text);
          return askLoginPassword(cb);
        } else {
          return cb(null, { username: program.username, password: program.password });
        }
      });
  });
}
