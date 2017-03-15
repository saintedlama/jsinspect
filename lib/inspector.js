var util         = require('util');
var EventEmitter = require('events').EventEmitter;
var fs           = require('fs');
var parse        = require('./parser').parse;
var Match        = require('./match');
var nodeUtils    = require('./nodeUtils');

class Inspector extends EventEmitter {
  /**
   * Creates a new Inspector, which extends EventEmitter. filePaths is expected
   * to be an array of string paths. Also accepts an options object with any
   * combination of the following: threshold, diff, identifiers and matches.
   * Threshold indicates the minimum number of nodes to analyze, and diff
   * enables the generation of diffs for any outputted matches. Identifiers
   * indicates whether or not the nodes in a match should also have matching
   * identifiers, and matches specifies the min number of instances for a match.
   * An instance of Inspector emits the following events: start, match and end.
   *
   * @constructor
   * @extends EventEmitter
   *
   * @param {string[]} filePaths The files on which to run the inspector
   * @param {object}   [opts]    Options to set for the inspector
   */
  constructor(filePaths, opts) {
    super();
    opts = opts || {};

    this._filePaths   = filePaths || [];
    this._threshold   = opts.threshold || 15;
    this._identifiers = opts.identifiers;
    this._diff        = opts.diff;
    this._matches     = opts.matches || 2;
    this._hash        = Object.create(null);
    this.numFiles     = this._filePaths.length;

    if (this._diff) {
      this._fileContents = {};
    }
  }

  /**
   * Runs the inspector on the given file paths, as provided in the constructor.
   * Emits a start event, followed by a series of match events for any detected
   * similarities, and an end event on completion. Iterating over filePaths and
   * reading their contents is done synchronously.
   *
   * @fires Inspector#start
   * @fires Inspector#match
   * @fires Inspector#end
   */
  run() {
    this.emit('start');

    // Iterate over files, and contents are split to allow
    // for specific line extraction
    this._filePaths.forEach((filePath) => {
      var src = fs.readFileSync(filePath, {encoding: 'utf8'});
      if (this._diff) this._fileContents[filePath] = src.split('\n');
      var syntaxTree = parse(src, filePath);
      this._walk(syntaxTree, (nodes) => this._insert(nodes));
    });

    this._analyze();
    this.emit('end');
  }

  /**
   * Walks a given node's AST, building up an array of child nodes that meet
   * the inspector's threshold. When found, the callback is invoked and passed
   * the array of nodes.
   *
   * @private
   *
   * @param {Node}     node The node to traverse
   * @param {function} fn   The callback to invoke
   */
  _walk(node, fn) {
    nodeUtils.walkSubtrees(node, (node, parent, ancestors) => {
      var state = ancestors.concat(node);
      if (nodeUtils.isAMD(state) ||
          nodeUtils.isCommonJS(state) ||
          nodeUtils.isES6ModuleImport(state)) {
        return;
      }

      var nodes = nodeUtils.getDFSTraversal(node, this._threshold);
      if (nodes.length === this._threshold) {
        fn(nodes);
      }
    });
  }

  /**
   * Generates a key based on the combined types of each of the supplied nodes.
   * Pushes the parent node, to an array at the generated key in _hash. The
   * parent node is then updated to include the same key for reverse lookup
   * purposes.
   *
   * @private
   *
   * @param {Node[]} nodes An array of nodes to insert
   */
  _insert(nodes) {
    var key = this._getHashKey(nodes);
    if (!this._hash[key]) {
      this._hash[key] = [];
    } else if (this._hash[key].indexOf(nodes[0]) !== -1) {
      return;
    }

    // Assign the parent node to the key
    this._hash[key].push(nodes[0]);

    // Store keys on the parent, mapping to the nodes
    if (!nodes[0].keys) {
      nodes[0].keys = {};
    }

    nodes[0].keys[key] = nodes;
  }

  /**
   * Traverses the keys at which the various nodes are stored. A key containing
   * an array of more than a single node indicates a potential match. The nodes
   * are then grouped if identifier matching is enabled. A match results in the
   * relevant child nodes being removed from any future results. This pruning
   * ensures that we only include the greatest common parent in a set of
   * matches.
   *
   * @private
   *
   * @fires Inspector#match
   */
  _analyze() {
    var key, match, i, nodes;

    // pruning takes advantage of the fact that keys are enumerated
    // based on insertion order. It's not ECMA spec, but is standard,
    // and saves us from having to perform a sort
    for (key in this._hash) {
      if (!this._hash[key] || this._hash[key].length < this._matches) {
        continue;
      }

      // nodes will be of type node[][], such that each entry is a match
      nodes = [this._hash[key].slice(0)];
      if (this._identifiers) {
        nodes = nodeUtils.groupByMatchingIds(key, nodes);
      }

      for (i = 0; i < nodes.length; i++) {
        if (nodes[i].length < this._matches) continue;

        match = new Match(nodes[i], key);
        if (this._diff) {
          match.generateDiffs(this._fileContents);
        }

        this.emit('match', match);
        this._prune(key, nodes[i]);
      }
    }
  }

  /**
   * Removes the nodes and their children from consideration in any additional
   * matches. It takes care not to modify buckets that contain nodes not
   * included by the given match. This is easily done by simply comparing the
   * lengths of the arrays.
   *
   * @private
   *
   * @param {string} key   Key in which the match was found
   * @param {Node[]} nodes An array of nodes to prune
   */
  _prune(key, nodes) {
    var length, i, j, targetNodes;

    length = nodes.length;

    for (i = 0; i < length; i++) {
      if (!nodes[i].keys[key]) continue;

      targetNodes = nodeUtils
        .getDFSTraversal(nodes[i], 10 * this._threshold)
        .slice(1);

      for (j = 0; j < targetNodes.length; j++) {
        // Continue since the node isn't a parent to any suff. long paths
        if (!targetNodes[j].keys) continue;

        this._removeNode(targetNodes[j], length);
      }
    }
  }

  /**
   * Removes a given node, as well as its children, from any _hash keys that
   * would not result in the silencing of a match. This is done by comparing the
   * length of the original array for the match, and the arrays for any other
   * keys at which they can be found.
   *
   * @private
   *
   * @param {Node} node   The node to remove
   * @param {int}  length The length of the original bucket containing the node
   */
  _removeNode(node, length) {
    if (!node.keys) return;

    for (var key in node.keys) {
      if (!this._hash[key] || this._hash[key].length > length) {
        return;
      }

      var index = this._hash[key].indexOf(node);
      if (index > -1) {
        this._hash[key].splice(index, 1);
      }

      // Delete empty buckets
      if (!this._hash[key].length) {
        delete this._hash[key];
      }
    }
  }

  /**
   * Generates a key consisting of the type of each of the passed nodes,
   * delimited by a colon.
   *
   * @private
   *
   * @param   {Node[]} nodes The nodes for which to generate the key
   * @returns {string} A key for the supplied nodes
   */
  _getHashKey(nodes) {
    return nodes.map(node => node.type).join(':');
  }
}

module.exports = Inspector;
