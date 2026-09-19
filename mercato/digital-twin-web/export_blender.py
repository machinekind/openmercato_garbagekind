"""Export only the cleaned geometric scene; never modify the evidence blend."""
import bpy, json, re, sys
from pathlib import Path
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
source, target = map(Path, args)
target.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(source))
original = bpy.data.scenes['01 | Model']
objects = [obj for obj in original.objects if obj.type == 'MESH']
scene = bpy.data.scenes.new('Web export')
bpy.context.window.scene = original
depsgraph = bpy.context.evaluated_depsgraph_get()
layers = {'architecture':'Architektura','windows':'Okna','curtains':'Zasłony','partitions':'Przegrody i szafki','tables':'Stoły','kitchen':'Aneks kuchenny','stage':'Scena','chairs':'Krzesła','plants':'Rośliny','services':'Instalacje','roof':'Sufit'}
mapping = {'Podloga i obrys':'architecture','Okna i zaslony':'windows','Przegrody i szafki':'partitions','Stoly - dopasowane do LiDAR':'tables','Aneks kuchenny':'kitchen','Scena prezentacyjna':'stage','Krzesla - polozenie orientacyjne':'chairs','Rosliny i zielona sciana':'plants','Wentylacja i oswietlenie':'services','Sufit':'roof'}
seats = [obj for obj in objects if obj.name.startswith('Krzeslo | siedzisko')]
pots = [obj for obj in objects if obj.name.startswith('Donica')]
groups = {}
for obj in objects:
    layer = next((mapping[col.name] for col in obj.users_collection if col.name in mapping), None)
    if layer is None: raise ValueError(obj.name)
    label = layers[layer]
    if layer == 'tables': label = obj.name.split(' | ')[0]
    elif obj.name.startswith(('Zaslona ', 'Karnisz ')):
        layer = 'curtains'; label = 'Zasłona ' + obj.name.split(' ')[1]
    elif layer == 'chairs': label = 'Krzesło %02d' % (1 + min(range(len(seats)), key=lambda idx:(obj.matrix_world.translation-seats[idx].matrix_world.translation).length))
    elif layer == 'plants': label = 'Roślina %02d' % (1 + min(range(len(pots)), key=lambda idx:(obj.matrix_world.translation-pots[idx].matrix_world.translation).length))
    elif layer == 'kitchen' and obj.name.startswith(('Wyspa','Kubek')): label = 'Wyspa kuchenna'
    elif layer == 'architecture' and obj.name.startswith('Sciana'): label = 'Ściana północna'
    groups.setdefault((layer,label),[]).append(obj)

materials = {}
elements = []
for group_index, ((layer,label),members) in enumerate(groups.items()):
    vertices, polygons, material_indices, smooth = [], [], [], []
    slots = []
    for obj in members:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        offset = len(vertices)
        vertices.extend([obj.matrix_world @ vertex.co for vertex in mesh.vertices])
        for polygon in mesh.polygons:
            polygons.append(tuple(offset + idx for idx in polygon.vertices))
            mat = mesh.materials[polygon.material_index] if mesh.materials else None
            key = mat.name if mat else 'Default'
            if key not in materials:
                clean = bpy.data.materials.new('Web '+key); clean.use_nodes = True
                clean.diffuse_color = mat.diffuse_color if mat else (.6,.6,.6,1)
                shader = clean.node_tree.nodes.get('Principled BSDF')
                shader.inputs['Base Color'].default_value = clean.diffuse_color
                shader.inputs['Roughness'].default_value = .78
                clean.use_backface_culling = False
                materials[key] = clean
            if key not in slots: slots.append(key)
            material_indices.append(slots.index(key)); smooth.append(polygon.use_smooth)
        evaluated.to_mesh_clear()
    mesh = bpy.data.meshes.new(label); mesh.from_pydata(vertices,[],polygons); mesh.update()
    for key in slots: mesh.materials.append(materials[key])
    for idx, polygon in enumerate(mesh.polygons):
        polygon.material_index = material_indices[idx]; polygon.use_smooth = smooth[idx]
    element_id = '%s-%02d' % (layer, group_index+1)
    obj = bpy.data.objects.new(element_id,mesh); scene.collection.objects.link(obj)
    obj['elementId'] = element_id; obj['layerId'] = layer
    web_vertices = [(vertex.x,vertex.z,-vertex.y) for vertex in vertices]
    bounds = {name:[round(fn(vertex[axis] for vertex in web_vertices),5) for axis in range(3)] for name,fn in [('min',min),('max',max)]}
    elements.append(dict(id=element_id,label=label,layerId=layer,nodeName=element_id,confidence='measured' if layer=='tables' else 'approximate',bounds=bounds,sourceObjectCount=len(members)))
bpy.context.window.scene = scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=str(target/'room.glb'),export_format='GLB',use_selection=True,export_extras=True,export_cameras=False,export_lights=False,export_animations=False,export_texcoords=False,export_yup=True)
raw=(target/'room.glb').read_bytes(); length=int.from_bytes(raw[12:16],'little'); gltf=json.loads(raw[20:20+length])
triangles=sum(gltf['accessors'][primitive['indices']]['count']//3 for mesh in gltf['meshes'] for primitive in mesh['primitives'])
manifest=dict(version=1,id='scene-7',name='Scene 7',units='m',modelUrl='/api/digital_twins/assets/room.glb',posterUrl='/api/digital_twins/assets/poster.webp',bounds={name:[fn(el['bounds'][name][axis] for el in elements) for axis in range(3)] for name,fn in [('min',min),('max',max)]},stats=dict(sourceBytes=source.stat().st_size,modelBytes=len(raw),sourceObjects=len(objects),meshCount=len(gltf['meshes']),triangles=triangles,materials=len(gltf.get('materials',[]))),provenance=dict(source='LiDAR + video',controlPoints=318,geometricOnly=True,scaleVerified=False),layers=[dict(id=key,label=label,defaultVisible=key!='roof',objectCount=sum(el['layerId']==key for el in elements)) for key,label in layers.items()],elements=elements)
(target/'room.manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
assert not gltf.get('images') and not gltf.get('animations')
assert sum(el['sourceObjectCount'] for el in elements)==len(objects)
print('WEB_EXPORT',json.dumps(manifest['stats']))

