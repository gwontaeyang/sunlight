// A valid 20×10 RGB PNG (correct CRCs — passes inspectPng / api.blob), generated once with the server test helper
// apps/server/test/helpers/png.ts makeTestPngBase64({ width: 20, height: 10 }). Kept as a constant because the web
// test project has no Node types (Buffer, node:zlib). Owner D.
export const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAIAAAA7N+mxAAABbklEQVR4nAXBMRGAIBSA4VfAAh4BKMAduwVcGEngxOb4T2xMJnBlsIA7dxYwAEcBEzy/T0SYhFmwghMWYRWisAm7kIVDOIVLuIVHeIUhfIIKIobJMBuswRkWw2qIhs2wG7LhMJyGy3AbHsNrGIbPoAYRz+SZPdbjPItn9UTP5tk92XN4Ts/luT2P5/UMz+dRj0hgCswBG3CBJbAGYmAL7IEcOAJn4ArcgSfwBkbgC2hAJDEl5oRNuMSSWBMxsSX2RE4ciTNxJe7Ek3gTI/ElNCFSmApzwRZcYSmshVjYCnshF47CWbgKd+EpvIVR+ApaEKlMlbliK66yVNZKrGyVvZIrR+WsXJW78lTeyqh8Fa2INKbG3LAN11gaayM2tsbeyI2jcTauxt14Gm9jNL6GNkQ6U2fu2I7rLJ21EztbZ+/kztE5O1fn7jydtzM6X0c7IsqkzIpVnLIoqxKVTdmVrBzKqVzKrTzKqwzlU1T5AUdbKrLQPW1aAAAAAElFTkSuQmCC';

export function testPngBytes(): Uint8Array {
  const bin = atob(TEST_PNG_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
