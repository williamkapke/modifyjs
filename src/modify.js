import clone from 'clone';
import equal from 'deep-equal';
import isObject from './lib/isObject';
import every from './lib/every';
import has from './lib/has';
import keys from './lib/keys';
import each from './lib/each.js';
import isPlainObject from './lib/isPlainObject';
import { isOperatorObject, isIndexable, isNumericKey } from './helpers';
import ModifyJsError from './ModifyJsError';

const _ = {all: every, each, keys, has, isObject};
// XXX need a strategy for passing the binding of $ into this
// function, from the compiled selector
//
// maybe just {key.up.to.just.before.dollarsign: array_index}
//
// XXX atomicity: if one modification fails, do we roll back the whole
// change?
//
// options:
//   - isInsert is set when _modify is being called to compute the document to
//     insert as part of an upsert operation. We use this primarily to figure
//     out when to set the fields in $setOnInsert, if present.
export default function(doc, mod, options) {
  if (options && options.each) {
    return
  }
  return _modify(doc, mod, {...options, returnInsteadOfReplacing: true})
}


const _modify = function (doc, mod, options) {
  options = options || {};
  if (!isPlainObject(mod))
    throw ModifyJsError("Modifier must be an object");

  // Make sure the caller can't mutate our data structures.
  mod = clone(mod);

  var isModifier = isOperatorObject(mod);

  var newDoc;

  if (!isModifier) {
    // replace the whole document
    newDoc = mod;
  } else {
    // apply modifiers to the doc.
    newDoc = clone(doc);
    _.each(mod, function (operand, op) {
      var modFunc = MODIFIERS[op];
      // Treat $setOnInsert as $set if this is an insert.
      if (!modFunc)
        throw ModifyJsError("Invalid modifier specified " + op);
      _.each(operand, function (arg, keypath) {
        if (keypath === '') {
          throw ModifyJsError("An empty update path is not valid.");
        }

        var keyparts = keypath.split('.');
        if (!_.all(keyparts)) {
          throw ModifyJsError(
            "The update path '" + keypath +
              "' contains an empty field name, which is not allowed.");
        }

        var target = findModTarget(newDoc, keyparts, {
          noCreate: NO_CREATE_MODIFIERS[op],
          forbidArray: (op === "$rename"),
          arrayIndices: options.arrayIndices
        });
        var field = keyparts.pop();
        modFunc(target, field, arg, keypath, newDoc);
      });
    });
  }

  if (options.returnInsteadOfReplacing) {
    return newDoc;
  } else {
    // move new document into place.
    _.each(_.keys(doc), function (k) {
      // Note: this used to be for (var k in doc) however, this does not
      // work right in Opera. Deleting from a doc while iterating over it
      // would sometimes cause opera to skip some keys.
      if (k !== '_id')
        delete doc[k];
    });
    _.each(newDoc, function (v, k) {
      doc[k] = v;
    });
  }
};

// for a.b.c.2.d.e, keyparts should be ['a', 'b', 'c', '2', 'd', 'e'],
// and then you would operate on the 'e' property of the returned
// object.
//
// if options.noCreate is falsey, creates intermediate levels of
// structure as necessary, like mkdir -p (and raises an exception if
// that would mean giving a non-numeric property to an array.) if
// options.noCreate is true, return undefined instead.
//
// may modify the last element of keyparts to signal to the caller that it needs
// to use a different value to index into the returned object (for example,
// ['a', '01'] -> ['a', 1]).
//
// if forbidArray is true, return null if the keypath goes through an array.
//
// if options.arrayIndices is set, use its first element for the (first) '$' in
// the path.
var findModTarget = function (doc, keyparts, options) {
  options = options || {};
  var usedArrayIndex = false;
  for (var i = 0; i < keyparts.length; i++) {
    var last = (i === keyparts.length - 1);
    var keypart = keyparts[i];
    var indexable = isIndexable(doc);
    if (!indexable) {
      if (options.noCreate)
        return undefined;
      var e = ModifyJsError(
        "cannot use the part '" + keypart + "' to traverse " + doc);
      e.setPropertyError = true;
      throw e;
    }
    if (doc instanceof Array) {
      if (options.forbidArray)
        return null;
      if (keypart === '$') {
        if (usedArrayIndex)
          throw ModifyJsError("Too many positional (i.e. '$') elements");
        if (!options.arrayIndices || !options.arrayIndices.length) {
          throw ModifyJsError("The positional operator did not find the " +
                               "match needed from the query");
        }
        keypart = options.arrayIndices[0];
        usedArrayIndex = true;
      } else if (isNumericKey(keypart)) {
        keypart = parseInt(keypart);
      } else {
        if (options.noCreate)
          return undefined;
        throw ModifyJsError(
          "can't append to array using string field name ["
                    + keypart + "]");
      }
      if (last)
        // handle 'a.01'
        keyparts[i] = keypart;
      if (options.noCreate && keypart >= doc.length)
        return undefined;
      while (doc.length < keypart)
        doc.push(null);
      if (!last) {
        if (doc.length === keypart)
          doc.push({});
        else if (typeof doc[keypart] !== "object")
          throw ModifyJsError("can't modify field '" + keyparts[i + 1] +
                      "' of list value " + JSON.stringify(doc[keypart]));
      }
    } else {
      if (!(keypart in doc)) {
        if (options.noCreate)
          return undefined;
        if (!last)
          doc[keypart] = {};
      }
    }

    if (last)
      return doc;
    doc = doc[keypart];
  }

};

var NO_CREATE_MODIFIERS = {
  $unset: true,
  $pop: true,
  $rename: true,
  $pull: true,
  $pullAll: true
};

var MODIFIERS = {
  $currentDate: function (target, field, arg) {
    if (typeof arg === "object" && arg.hasOwnProperty("$type")) {
       if (arg.$type !== "date") {
          throw ModifyJsError(
            "Minimongo does currently only support the date type " +
            "in $currentDate modifiers",
            { field });
       }
    } else if (arg !== true) {
      throw ModifyJsError("Invalid $currentDate modifier", { field });
    }
    target[field] = new Date();
  },
  $min: function (target, field, arg) {
    if (typeof arg !== "number") {
      throw ModifyJsError("Modifier $min allowed for numbers only", { field });
    }
    if (field in target) {
      if (typeof target[field] !== "number") {
        throw ModifyJsError(
          "Cannot apply $min modifier to non-number", { field });
      }
      if (target[field] > arg) {
        target[field] = arg;
      }
    } else {
      target[field] = arg;
    }
  },
  $max: function (target, field, arg) {
    if (typeof arg !== "number") {
      throw ModifyJsError("Modifier $max allowed for numbers only", { field });
    }
    if (field in target) {
      if (typeof target[field] !== "number") {
        throw ModifyJsError(
          "Cannot apply $max modifier to non-number", { field });
      }
      if (target[field] < arg) {
         target[field] = arg;
      }
    } else {
      target[field] = arg;
    }
  },
  $inc: function (target, field, arg) {
    if (typeof arg !== "number")
      throw ModifyJsError("Modifier $inc allowed for numbers only", { field });
    if (field in target) {
      if (typeof target[field] !== "number")
        throw ModifyJsError(
          "Cannot apply $inc modifier to non-number", { field });
      target[field] += arg;
    } else {
      target[field] = arg;
    }
  },
  $set: function (target, field, arg) {
    if (!_.isObject(target)) { // not an array or an object
      var e = ModifyJsError(
        "Cannot set property on non-object field", { field });
      e.setPropertyError = true;
      throw e;
    }
    if (target === null) {
      var e = ModifyJsError("Cannot set property on null", { field });
      e.setPropertyError = true;
      throw e;
    }
    target[field] = arg;
  },
  $setOnInsert: function (target, field, arg) {
    // converted to `$set` in `_modify`
  },
  $unset: function (target, field, arg) {
    if (target !== undefined) {
      if (target instanceof Array) {
        if (field in target)
          target[field] = null;
      } else
        delete target[field];
    }
  },
  $push: function (target, field, arg) {
    if (target[field] === undefined)
      target[field] = [];
    if (!(target[field] instanceof Array))
      throw ModifyJsError(
        "Cannot apply $push modifier to non-array", { field });

    if (!(arg && arg.$each)) {
      // Simple mode: not $each
      target[field].push(arg);
      return;
    }

    // Fancy mode: $each (and maybe $slice and $sort and $position)
    var toPush = arg.$each;
    if (!(toPush instanceof Array))
      throw ModifyJsError("$each must be an array", { field });

    // Parse $position
    var position = undefined;
    if ('$position' in arg) {
      if (typeof arg.$position !== "number")
        throw ModifyJsError("$position must be a numeric value", { field });
      // XXX should check to make sure integer
      if (arg.$position < 0)
        throw ModifyJsError(
          "$position in $push must be zero or positive", { field });
      position = arg.$position;
    }

    // Parse $slice.
    var slice = undefined;
    if ('$slice' in arg) {
      if (typeof arg.$slice !== "number")
        throw ModifyJsError("$slice must be a numeric value", { field });
      // XXX should check to make sure integer
      if (arg.$slice > 0)
        throw ModifyJsError(
          "$slice in $push must be zero or negative", { field });
      slice = arg.$slice;
    }

    // Parse $sort.
    var sortFunction = undefined;
    if (arg.$sort) {
      throw ModifyJsError("$sort in $push not implemented yet");
      // if (slice === undefined)
      //   throw ModifyJsError("$sort requires $slice to be present", { field });
      // // XXX this allows us to use a $sort whose value is an array, but that's
      // // actually an extension of the Node driver, so it won't work
      // // server-side. Could be confusing!
      // // XXX is it correct that we don't do geo-stuff here?
      // sortFunction = new Minimongo.Sorter(arg.$sort).getComparator();
      // for (var i = 0; i < toPush.length; i++) {
      //   if (_f._type(toPush[i]) !== 3) {
      //     throw ModifyJsError("$push like modifiers using $sort " +
      //                 "require all elements to be objects", { field });
      //   }
      // }
    }

    // Actually push.
    if (position === undefined) {
      for (var j = 0; j < toPush.length; j++)
        target[field].push(toPush[j]);
    } else {
      var spliceArguments = [position, 0];
      for (var j = 0; j < toPush.length; j++)
        spliceArguments.push(toPush[j]);
      Array.prototype.splice.apply(target[field], spliceArguments);
    }

    // Actually sort.
    if (sortFunction)
      target[field].sort(sortFunction);

    // Actually slice.
    if (slice !== undefined) {
      if (slice === 0)
        target[field] = [];  // differs from Array.slice!
      else
        target[field] = target[field].slice(slice);
    }
  },
  $pushAll: function (target, field, arg) {
    if (!(typeof arg === "object" && arg instanceof Array))
      throw ModifyJsError("Modifier $pushAll/pullAll allowed for arrays only");
    var x = target[field];
    if (x === undefined)
      target[field] = arg;
    else if (!(x instanceof Array))
      throw ModifyJsError(
        "Cannot apply $pushAll modifier to non-array", { field });
    else {
      for (var i = 0; i < arg.length; i++)
        x.push(arg[i]);
    }
  },
  $addToSet: function (target, field, arg) {
    var isEach = false;
    if (typeof arg === "object") {
      //check if first key is '$each'
      const keys = Object.keys(arg);
      if (keys[0] === "$each"){
        isEach = true;
      }
    }
    var values = isEach ? arg["$each"] : [arg];
    var x = target[field];
    if (x === undefined)
      target[field] = values;
    else if (!(x instanceof Array))
      throw ModifyJsError(
        "Cannot apply $addToSet modifier to non-array", { field });
    else {
      _.each(values, function (value) {
        for (var i = 0; i < x.length; i++)
          if (equal(value, x[i]))
            return;
        x.push(value);
      });
    }
  },
  $pop: function (target, field, arg) {
    if (target === undefined)
      return;
    var x = target[field];
    if (x === undefined)
      return;
    else if (!(x instanceof Array))
      throw ModifyJsError(
        "Cannot apply $pop modifier to non-array", { field });
    else {
      if (typeof arg === 'number' && arg < 0)
        x.splice(0, 1);
      else
        x.pop();
    }
  },
  $pull: function (target, field, arg) {
    if (target === undefined)
      return;
    var x = target[field];
    if (x === undefined)
      return;
    else if (!(x instanceof Array))
      throw ModifyJsError(
        "Cannot apply $pull/pullAll modifier to non-array", { field });
    else {
      throw ModifyJsError("$pull not implemented yet")
      // var out = [];
      // if (arg != null && typeof arg === "object" && !(arg instanceof Array)) {
      //   // XXX would be much nicer to compile this once, rather than
      //   // for each document we modify.. but usually we're not
      //   // modifying that many documents, so we'll let it slide for
      //   // now
      //
      //   // XXX Minimongo.Matcher isn't up for the job, because we need
      //   // to permit stuff like {$pull: {a: {$gt: 4}}}.. something
      //   // like {$gt: 4} is not normally a complete selector.
      //   // same issue as $elemMatch possibly?
      //   var matcher = new Minimongo.Matcher(arg);
      //   for (var i = 0; i < x.length; i++)
      //     if (!matcher.documentMatches(x[i]).result)
      //       out.push(x[i]);
      // } else {
      //   for (var i = 0; i < x.length; i++)
      //     if (!_f._equal(x[i], arg))
      //       out.push(x[i]);
      // }
      // target[field] = out;
    }
  },
  $pullAll: function (target, field, arg) {
    if (!(typeof arg === "object" && arg instanceof Array))
      throw ModifyJsError(
        "Modifier $pushAll/pullAll allowed for arrays only", { field });
    if (target === undefined)
      return;
    var x = target[field];
    if (x === undefined)
      return;
    else if (!(x instanceof Array))
      throw ModifyJsError(
        "Cannot apply $pull/pullAll modifier to non-array", { field });
    else {
      var out = [];
      for (var i = 0; i < x.length; i++) {
        var exclude = false;
        for (var j = 0; j < arg.length; j++) {
          if (equal(x[i], arg[j])) {
            exclude = true;
            break;
          }
        }
        if (!exclude)
          out.push(x[i]);
      }
      target[field] = out;
    }
  },
  $rename: function (target, field, arg, keypath, doc) {
    if (keypath === arg)
      // no idea why mongo has this restriction..
      throw ModifyJsError("$rename source must differ from target", { field });
    if (target === null)
      throw ModifyJsError("$rename source field invalid", { field });
    if (typeof arg !== "string")
      throw ModifyJsError("$rename target must be a string", { field });
    if (arg.indexOf('\0') > -1) {
      // Null bytes are not allowed in Mongo field names
      // https://docs.mongodb.com/manual/reference/limits/#Restrictions-on-Field-Names
      throw ModifyJsError(
        "The 'to' field for $rename cannot contain an embedded null byte",
        { field });
    }
    if (target === undefined)
      return;
    var v = target[field];
    delete target[field];

    var keyparts = arg.split('.');
    var target2 = findModTarget(doc, keyparts, {forbidArray: true});
    if (target2 === null)
      throw ModifyJsError("$rename target field invalid", { field });
    var field2 = keyparts.pop();
    target2[field2] = v;
  },
  $bit: function (target, field, arg) {
    // XXX mongo only supports $bit on integers, and we only support
    // native javascript numbers (doubles) so far, so we can't support $bit
    throw ModifyJsError("$bit is not supported", { field });
  }
};
