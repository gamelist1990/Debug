const { ProtoDefCompiler } = require('protodef').Compiler
const { FullPacketParser, Serializer } = require('protodef')

const protocol = require("../protocol/protocol.json")
const compiler = new ProtoDefCompiler()

compiler.addTypesToCompile(protocol.types)
compiler.addTypes(require('../datatypes/compiler-minecraft'))

const proto = compiler.compileProtoDefSync()

function createSerializer() {
  return new Serializer(proto, 'mcpe_packet')
}

function createDeserializer() {
  return new FullPacketParser(proto, 'mcpe_packet')
}

module.exports = { createDeserializer, createSerializer }