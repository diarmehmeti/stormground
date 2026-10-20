/* Native bridge for the Android app: Google Play purchases + AdMob rewarded videos.
   Loaded only inside the Capacitor app (see scripts/build-www.js). */
(function () {
  'use strict';
  if (!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform())) return;
  var APP = window.SG_APP || {}, BASE = String(window.SG_SERVER || '');
  var IDS = ['coins_300', 'coins_800', 'coins_2200', 'coins_5000', 'coins_12000'];

  function authPost(path, body) {
    var tok = ''; try { tok = localStorage.getItem('stormground.token') || ''; } catch (e) {}
    return fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }

  /* ---------- Google Play Billing ---------- */
  var store = null, storeReady = false, waiting = {};
  function initStore() {
    var CP = window.CdvPurchase; if (!CP || store) return !!store;
    store = CP.store;
    store.register(IDS.map(function (id) { return { id: id, type: CP.ProductType.CONSUMABLE, platform: CP.Platform.GOOGLE_PLAY }; }));
    store.when().approved(function (tx) {
      var p = tx.products && tx.products[0], sku = p && p.id;
      var token = (tx.nativePurchase && tx.nativePurchase.purchaseToken) || tx.transactionId || '';
      if (!sku || !token) return;
      authPost('/api/purchase', { sku: sku, token: token }).then(function (r) {
        if (r.ok) tx.finish();               /* consumes the item so it can be bought again */
        var w = waiting[sku];
        if (w) { delete waiting[sku]; w({ ok: !!r.ok }); }
        else if (r.ok && r.j && r.j.coins && window.StormgroundGrant) window.StormgroundGrant(r.j.coins); /* purchase finished after an app restart */
      }, function () { var w = waiting[sku]; if (w) { delete waiting[sku]; w({ ok: false }); } });
    });
    store.initialize([CP.Platform.GOOGLE_PLAY]).then(function () { storeReady = true; });
    return true;
  }
  var tries = 0, t = setInterval(function () { if (initStore() || ++tries > 40) clearInterval(t); }, 300);

  window.StormgroundIAP = {
    products: function () {
      if (!store) return Promise.resolve([]);
      return Promise.resolve(IDS.map(function (id) {
        var p = store.get(id, window.CdvPurchase.Platform.GOOGLE_PLAY), o = p && p.getOffer && p.getOffer();
        var price = (o && o.pricingPhases && o.pricingPhases[0] && o.pricingPhases[0].price) || (p && p.pricing && p.pricing.price) || '';
        return { id: id, price: price };
      }).filter(function (x) { return x.price; }));
    },
    purchase: function (sku) {
      return new Promise(function (resolve) {
        if (!store || !storeReady) return resolve({ ok: false });
        var p = store.get(sku, window.CdvPurchase.Platform.GOOGLE_PLAY), o = p && p.getOffer && p.getOffer();
        if (!o) return resolve({ ok: false });
        waiting[sku] = resolve;
        store.order(o).then(function (err) { if (err && waiting[sku]) { delete waiting[sku]; resolve({ ok: false }); } });
      });
    }
  };

  /* ---------- AdMob rewarded video ---------- */
  var AdMob = Capacitor.Plugins && Capacitor.Plugins.AdMob, adReady = false;
  function prepareAd() {
    if (!AdMob) return;
    AdMob.prepareRewardVideoAd({ adId: APP.admobRewardedId, isTesting: !!APP.admobTest }).then(function () { adReady = true; }, function () { adReady = false; setTimeout(prepareAd, 30000); });
  }
  if (AdMob) AdMob.initialize({ initializeForTesting: !!APP.admobTest }).then(prepareAd, function () {});
  window.StormgroundAds = {
    available: function () { return !!AdMob; },
    showRewarded: function () {
      return new Promise(function (resolve) {
        if (!AdMob || !adReady) { prepareAd(); return resolve(false); }
        var got = false, handles = [], finished = false;
        function end(v) { if (finished) return; finished = true; handles.forEach(function (h) { try { h.remove(); } catch (e) {} }); adReady = false; prepareAd(); resolve(v); }
        function on(ev, fn) { var h = AdMob.addListener(ev, fn); if (h && h.then) h.then(function (x) { handles.push(x); }); else handles.push(h); }
        on('onRewardedVideoAdReward', function () { got = true; });
        on('onRewardedVideoAdDismissed', function () { end(got); });
        on('onRewardedVideoAdFailedToShow', function () { end(false); });
        AdMob.showRewardVideoAd().catch(function () { end(false); });
      });
    }
  };
})();
