"""Lossless adapter between compact export columns and canonical evidence."""
import base64
import pyarrow as pa
import pyarrow.parquet as pq

KEY = b'stockmonitor.lossless_adapter_v1'
SCHEMA = b'stockmonitor.original_schema'

def encode(original, compact):
    # Rows must be aligned by the caller before attaching reconstruction data.
    changed = [name for name in original.column_names if name not in compact.column_names or not original[name].equals(compact[name])]
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, original.select(changed).schema,
                           options=pa.ipc.IpcWriteOptions(compression='zstd')) as writer:
        writer.write_table(original.select(changed))
    metadata = dict(compact.schema.metadata or {})
    metadata[KEY] = base64.b64encode(sink.getvalue().to_pybytes())
    metadata[SCHEMA] = base64.b64encode(original.schema.serialize().to_pybytes())
    return compact.replace_schema_metadata(metadata)

def decode(table):
    metadata = table.schema.metadata or {}
    if KEY not in metadata:
        return table
    restored = pa.ipc.open_stream(base64.b64decode(metadata[KEY])).read_all()
    schema = pa.ipc.read_schema(pa.BufferReader(base64.b64decode(metadata[SCHEMA])))
    if restored.num_rows != table.num_rows:
        raise ValueError('Compact reconstruction row count mismatch')
    return pa.Table.from_arrays([restored[name] if name in restored.column_names else table[name] for name in schema.names], schema=schema)

def read_table(path):
    return decode(pq.ParquetFile(path).read())
