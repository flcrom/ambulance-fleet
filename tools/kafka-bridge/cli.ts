import {Kafka} from '../simulator/node_modules/kafkajs';
import {IngestClient} from '../../worker/src/feeds/core';
import {processRecord} from './bridge';
const required=(k:string)=>{const v=process.env[k];if(!v)throw new Error(`${k} required`);return v;};
const brokers=required('KAFKA_BROKERS').split(',').map(x=>x.trim());
const client=new IngestClient(required('FLEET_API_URL'),required('FLEET_TOKEN'));
const map=JSON.parse(required('DRIVER_VEHICLE_MAP')) as Record<string,string>;
if(!map||Array.isArray(map)||typeof map!=='object'||Object.values(map).some(x=>typeof x!=='string'||!x))throw new Error('Invalid DRIVER_VEHICLE_MAP');
const mechanism=process.env.KAFKA_SASL_MECHANISM;
if(mechanism && !['plain','scram-sha-256','scram-sha-512'].includes(mechanism))throw new Error('Unsupported Kafka SASL mechanism');
const kafka=new Kafka({clientId:'fleet-bridge',brokers,ssl:process.env.KAFKA_TLS!=='false',...(mechanism?{sasl:{mechanism:mechanism as 'plain',username:required('KAFKA_SASL_USERNAME'),password:required('KAFKA_SASL_PASSWORD')}}:{})});
const consumer=kafka.consumer({groupId:required('KAFKA_GROUP_ID')});
await consumer.connect();await consumer.subscribe({topic:'driver_locations',fromBeginning:false});
let stopping=false;
for(const sig of ['SIGINT','SIGTERM'] as const)process.on(sig,()=>{stopping=true;void consumer.disconnect();});
await consumer.run({autoCommit:false,eachBatchAutoResolve:false,eachBatch:async({batch,resolveOffset,heartbeat,isRunning,isStale})=>{
  for(const message of batch.messages){
    if(stopping||!isRunning()||isStale())return;
    // Invalid/failed messages block this partition; never skip poison records silently.
    await processRecord({topic:batch.topic,partition:batch.partition,offset:message.offset,value:message.value?.toString()??null},map,p=>client.post(p),async next=>{
      await consumer.commitOffsets([{topic:batch.topic,partition:batch.partition,offset:next}]);
      resolveOffset(message.offset);
    });await heartbeat();
  }
}});
