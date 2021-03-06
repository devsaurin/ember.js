import { Meta, peekMeta } from '@ember/-internals/meta';
import { symbol } from '@ember/-internals/utils';
import { EMBER_METAL_TRACKED_PROPERTIES } from '@ember/canary-features';
import { DEBUG } from '@glimmer/env';
import changeEvent from './change_event';
import { descriptorForProperty } from './descriptor_map';
import { sendEvent } from './events';
import { flushSyncObservers } from './observer';
import ObserverSet from './observer_set';
import { markObjectAsDirty } from './tags';
import { assertNotRendered } from './transaction';

/**
 @module ember
 @private
 */

export const PROPERTY_DID_CHANGE = symbol('PROPERTY_DID_CHANGE');

const observerSet = new ObserverSet();
let deferred = 0;

/**
  This function is called just after an object property has changed.
  It will notify any observers and clear caches among other things.

  Normally you will not need to call this method directly but if for some
  reason you can't directly watch a property you can invoke this method
  manually.

  @method notifyPropertyChange
  @for @ember/object
  @param {Object} obj The object with the property that will change
  @param {String} keyName The property key (or path) that will change.
  @param {Meta} meta The objects meta.
  @return {void}
  @since 3.1.0
  @public
*/
function notifyPropertyChange(obj: object, keyName: string, _meta?: Meta | null): void {
  let meta = _meta === undefined ? peekMeta(obj) : _meta;

  if (meta !== null && (meta.isInitializing() || meta.isPrototypeMeta(obj))) {
    return;
  }

  if (!EMBER_METAL_TRACKED_PROPERTIES) {
    let possibleDesc = descriptorForProperty(obj, keyName, meta);

    if (possibleDesc !== undefined && typeof possibleDesc.didChange === 'function') {
      possibleDesc.didChange(obj, keyName);
    }

    if (meta !== null && meta.peekWatching(keyName) > 0) {
      dependentKeysDidChange(obj, keyName, meta);
      chainsDidChange(obj, keyName, meta);
      notifyObservers(obj, keyName, meta);
    }
  }

  if (meta !== null) {
    markObjectAsDirty(obj, keyName, meta);
  }

  if (EMBER_METAL_TRACKED_PROPERTIES && deferred <= 0) {
    flushSyncObservers();
  }

  if (PROPERTY_DID_CHANGE in obj) {
    obj[PROPERTY_DID_CHANGE](keyName);
  }

  if (DEBUG) {
    assertNotRendered(obj, keyName);
  }
}

const SEEN_MAP = new Map<object, Set<string>>();
let IS_TOP_SEEN_MAP = true;

// called whenever a property has just changed to update dependent keys
function dependentKeysDidChange(obj: object, depKey: string, meta: Meta): void {
  if (meta.isSourceDestroying() || !meta.hasDeps(depKey)) {
    return;
  }
  let seen = SEEN_MAP;
  let isTop = IS_TOP_SEEN_MAP;

  if (isTop) {
    IS_TOP_SEEN_MAP = false;
  }

  iterDeps(notifyPropertyChange, obj, depKey, seen, meta);

  if (isTop) {
    SEEN_MAP.clear();
    IS_TOP_SEEN_MAP = true;
  }
}

function iterDeps(
  method: (obj: object, key: string, meta: Meta) => void,
  obj: object,
  depKey: string,
  seen: Map<object, Set<string>>,
  meta: Meta
): void {
  let current = seen.get(obj);

  if (current === undefined) {
    current = new Set();
    seen.set(obj, current);
  }

  if (current.has(depKey)) {
    return;
  }

  let possibleDesc;
  meta.forEachInDeps(depKey, (key: string) => {
    possibleDesc = descriptorForProperty(obj, key, meta);

    if (possibleDesc !== undefined && possibleDesc._suspended === obj) {
      return;
    }

    method(obj, key, meta);
  });
}

function chainsDidChange(_obj: object, keyName: string, meta: Meta): void {
  let chainWatchers = meta.readableChainWatchers();
  if (chainWatchers !== undefined) {
    chainWatchers.notify(keyName, true, notifyPropertyChange);
  }
}

function overrideChains(_obj: object, keyName: string, meta: Meta): void {
  let chainWatchers = meta.readableChainWatchers();
  if (chainWatchers !== undefined) {
    chainWatchers.revalidate(keyName);
  }
}

/**
  @method beginPropertyChanges
  @chainable
  @private
*/
function beginPropertyChanges(): void {
  deferred++;
}

/**
  @method endPropertyChanges
  @private
*/
function endPropertyChanges(): void {
  deferred--;
  if (deferred <= 0) {
    if (EMBER_METAL_TRACKED_PROPERTIES) {
      flushSyncObservers();
    } else {
      observerSet.flush();
    }
  }
}

/**
  Make a series of property changes together in an
  exception-safe way.

  ```javascript
  Ember.changeProperties(function() {
    obj1.set('foo', mayBlowUpWhenSet);
    obj2.set('bar', baz);
  });
  ```

  @method changeProperties
  @param {Function} callback
  @private
*/
function changeProperties(callback: () => void): void {
  beginPropertyChanges();
  try {
    callback();
  } finally {
    endPropertyChanges();
  }
}

function notifyObservers(obj: object, keyName: string, meta: Meta): void {
  if (meta.isSourceDestroying()) {
    return;
  }

  let eventName = changeEvent(keyName);
  if (deferred > 0) {
    observerSet.add(obj, keyName, eventName);
  } else {
    sendEvent(obj, eventName, [obj, keyName]);
  }
}

export {
  notifyPropertyChange,
  overrideChains,
  beginPropertyChanges,
  endPropertyChanges,
  changeProperties,
};
