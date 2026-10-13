/** Original bounded streaming protobuf scanner. Only requested fields are retained. */
export interface ProtoField { tag:number; wire:number; value:bigint|number|Uint8Array }
export interface Budget {remaining:number}
export function* scan(bytes:Uint8Array,budget:Budget={remaining:20000},selected?:ReadonlySet<number>):Generator<ProtoField> {
 let i=0;
 const varint=()=>{let n=0n;for(let k=0;k<10;k++){if(i>=bytes.length)throw new Error('Truncated varint');const b=bytes[i++];n|=BigInt(b&127)<<BigInt(7*k);if(!(b&128)){if(k===9&&b>1)throw new Error('Varint overflow');return n;}}throw new Error('Varint overflow');};
 const take=(n:number)=>{if(!Number.isSafeInteger(n)||n<0||i+n>bytes.length)throw new Error('Truncated protobuf');const b=bytes.subarray(i,i+n);i+=n;return b;};
 while(i<bytes.length){if(--budget.remaining<0)throw new Error('Protobuf field budget exceeded');const key=varint();if(key>0xffffffffn)throw new Error('Invalid field key');const tag=Number(key>>3n),wire=Number(key&7n);if(!tag||tag>536870911)throw new Error('Invalid field tag');
 let value:ProtoField['value'];if(wire===0)value=varint();else if(wire===2)value=take(Number(varint()));else if(wire===5){const b=take(4);value=new DataView(b.buffer,b.byteOffset,4).getFloat32(0,true);}else if(wire===1)value=take(8);else throw new Error('Unsupported protobuf wire type');
 if(!selected||selected.has(tag))yield {tag,wire,value};
 }
}
export const fields=(bytes:Uint8Array,budget?:Budget,selected?:ReadonlySet<number>):ProtoField[]=>Array.from(scan(bytes,budget,selected));
/** Repeated encodings of a singular embedded message merge in wire order. */
export function sub(f:ProtoField[],tag:number,budget?:Budget,selected?:ReadonlySet<number>):ProtoField[]{return f.filter(x=>x.tag===tag&&x.wire===2).flatMap(x=>fields(x.value as Uint8Array,budget,selected));}
const last=(f:ProtoField[],tag:number,wire:number)=>f.findLast(x=>x.tag===tag&&x.wire===wire)?.value;
export const text=(f:ProtoField[],tag:number):string=>{const v=last(f,tag,2);return v instanceof Uint8Array?new TextDecoder().decode(v):'';};
export const number=(f:ProtoField[],tag:number):number|undefined=>{const v=last(f,tag,0);return typeof v==='bigint'?Number(v):undefined;};
export const float=(f:ProtoField[],tag:number):number|undefined=>{const v=last(f,tag,5);return typeof v==='number'?v:undefined;};
