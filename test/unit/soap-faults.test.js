"use strict";

// Offline tests for SOAP fault handling: a stub SOAP client stands in for CUCM.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const axlService = require("../../dist/index.js");

const FAULT = "Query request too large. Total rows matched: 38558 rows. Suggestive Row Fetch: less than 896 rows";

/** strong-soap behaviour on a fault: emit "soapError" on the client, then call back with the same error */
function soapFault(client, faultstring, cb) {
  const err = new Error(`soap:Server: ${faultstring}`);
  err.root = { Envelope: { Body: { Fault: { faultcode: "soap:Server", faultstring } } } };
  client.emit("soapError", err);
  cb(err, null, "<soapenv:Envelope/>");
}

function serviceWith(handler) {
  const service = new axlService("cucm.example.com", "user", "pass", "14.0", { retry: { retries: 0 } });
  const client = new EventEmitter();
  client.AXLAPIService = { AXLPort: { executeSQLQuery: (message, cb) => handler(client, message, cb) } };
  service._soapClient = client;
  return { service, client };
}

describe("SOAP fault handling", () => {
  it("leaves no soapError listeners behind after successful and failed calls", async () => {
    const { service, client } = serviceWith((c, message, cb) => {
      if (message.sql === "bad") soapFault(c, "A syntax error has occurred.", cb);
      else setImmediate(() => cb(null, { return: { row: [{ name: "x" }] } }, "<ok/>"));
    });
    for (let i = 0; i < 15; i++) {
      await service.executeSqlQuery("select 1");
      await service.executeSqlQuery("bad").catch(() => {});
    }
    assert.equal(client.listenerCount("soapError"), 0);
  });

  it("a fault on one request does not reject another request in flight", async () => {
    const { service } = serviceWith((c, message, cb) => {
      if (message.sql === "bad") setImmediate(() => soapFault(c, FAULT, cb));
      else setTimeout(() => cb(null, { return: { row: [{ name: "ok" }] } }, "<ok/>"), 20);
    });
    const [good, bad] = await Promise.allSettled([service.executeSqlQuery("select 1"), service.executeSqlQuery("bad")]);
    assert.equal(good.status, "fulfilled");
    assert.deepEqual(good.value, { row: [{ name: "ok" }] });
    assert.equal(bad.status, "rejected");
    assert.equal(bad.reason.message, FAULT);
  });

  it("maps faults to AXLOperationError with the faultstring", async () => {
    const { service } = serviceWith((c, _m, cb) => soapFault(c, FAULT, cb));
    await assert.rejects(service.executeSqlQuery("select * from device"), (err) => {
      assert.equal(err.name, "AXLOperationError");
      assert.equal(err.message, FAULT);
      assert.equal(err.faultCode, "soap:Server");
      return true;
    });
  });

  it("maps authentication faults to AXLAuthError", async () => {
    const { service } = serviceWith((c, _m, cb) => soapFault(c, "Authentication failed", cb));
    await assert.rejects(service.executeSqlQuery("select 1"), (err) => err.name === "AXLAuthError");
  });
});
