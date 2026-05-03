import type { Manifold, ManifoldStatic, Mat4, Mesh, Polygons, Vec2, Vec3 } from 'manifold-3d'
import quickhull from 'quickhull3d'
import { Matrix4 } from 'three/src/math/Matrix4'
import { Vector3 } from 'three/src/math/Vector3'
import { Vector2 } from 'three/src/math/Vector2'

// Cache for imported STL meshes keyed by URL
const stlCache = new Map<string, Manifold>()
const stlReady = new Map<string, Promise<void>>()
export const CHERRY_MX_STL = '/cherry-mx.stl'

/** Parse a binary or ASCII STL ArrayBuffer into a Manifold mesh, then create a Manifold.
 *  If the mesh is not manifold, attempts repair by merging coincident vertices.
 */
function parseSTL(manifold: ManifoldStatic, buffer: ArrayBuffer): Manifold {
    const data = new DataView(buffer)
    const header = new Uint8Array(buffer, 0, 80)
    const headerText = String.fromCharCode(...header).trim()
    const triangles = data.getUint32(80, true)

    let triVerts: Uint32Array
    let vertProperties: Float32Array

    if (headerText.startsWith('solid') && triangles === 0) {
        // ASCII STL fallback
        const text = new TextDecoder().decode(buffer)
        const vertexPattern = /vertex\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g
        const verts: number[][] = []
        let match: RegExpExecArray | null
        while ((match = vertexPattern.exec(text)) !== null) {
            verts.push([parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])])
        }
        const numTris = Math.floor(verts.length / 3)
        vertProperties = new Float32Array(verts.length * 3)
        triVerts = new Uint32Array(numTris * 3)
        for (let i = 0; i < verts.length; i++) {
            vertProperties[i * 3] = verts[i][0]
            vertProperties[i * 3 + 1] = verts[i][1]
            vertProperties[i * 3 + 2] = verts[i][2]
            triVerts[i] = i
        }
    } else {
        // Binary STL
        const numProp = 3
        vertProperties = new Float32Array(triangles * 3 * numProp)
        triVerts = new Uint32Array(triangles * 3)
        for (let i = 0; i < triangles; i++) {
            const offset = 84 + i * 50
            for (let v = 0; v < 3; v++) {
                const vOffset = offset + 12 + v * 12
                const idx = i * 3 + v
                vertProperties[idx * 3] = data.getFloat32(vOffset, true)
                vertProperties[idx * 3 + 1] = data.getFloat32(vOffset + 4, true)
                vertProperties[idx * 3 + 2] = data.getFloat32(vOffset + 8, true)
                triVerts[idx] = idx
            }
        }
    }

    const mesh = new manifold.Mesh({ numProp: 3, vertProperties, triVerts })
    try {
        return new manifold.Manifold(mesh)
    } catch {
        // Mesh isn't manifold — merge coincident vertices and try again
        const merged = mergeVertices(manifold, mesh)
        return new manifold.Manifold(merged)
    }
}

/** Merge vertices that are at the same position (within epsilon) to fix non-manifold meshes. */
function mergeVertices(manifold: ManifoldStatic, mesh: Mesh): Mesh {
    const eps = 1e-6
    const vertCount = mesh.vertProperties.length / 3
    const indexMap = new Int32Array(vertCount)
    const newVerts: number[] = []
    const vertMap = new Map<string, number>()

    for (let i = 0; i < vertCount; i++) {
        const x = mesh.vertProperties[i * 3]
        const y = mesh.vertProperties[i * 3 + 1]
        const z = mesh.vertProperties[i * 3 + 2]
        const key = `${Math.round(x / eps)}_${Math.round(y / eps)}_${Math.round(z / eps)}`
        const existing = vertMap.get(key)
        if (existing !== undefined) {
            indexMap[i] = existing
        } else {
            const newIndex = newVerts.length / 3
            newVerts.push(x, y, z)
            vertMap.set(key, newIndex)
            indexMap[i] = newIndex
        }
    }

    const newTriVerts = new Uint32Array(mesh.triVerts.length)
    for (let i = 0; i < mesh.triVerts.length; i++) {
        newTriVerts[i] = indexMap[mesh.triVerts[i]]
    }

    return new manifold.Mesh({
        numProp: 3,
        vertProperties: new Float32Array(newVerts),
        triVerts: newTriVerts
    })
}

/** Pre-fetch and parse an STL file so it's available synchronously later. */
export function preloadSTL(manifoldStatic: ManifoldStatic, url: string): Promise<void> {
    if (stlCache.has(url)) return Promise.resolve()
    if (stlReady.has(url)) return stlReady.get(url)!
    const p = fetch(url)
        .then(r => r.arrayBuffer())
        .then(buf => { stlCache.set(url, parseSTL(manifoldStatic, buf)) })
    stlReady.set(url, p)
    return p
}

/** Wait for a preloaded STL to be ready. No-op if already loaded or not needed. */
export async function ensureSTL(url: string): Promise<void> {
    if (stlCache.has(url)) return
    if (stlReady.has(url)) await stlReady.get(url)
}

function d(m: Manifold|Manifold[]): Manifold {
    if (Array.isArray(m)) {
        if (m.length > 1) throw new Error('To many items to unpack')
        return d(m[0])
    }
    return m
}

function dd(m: Manifold[]): Manifold[] {
    const objs: Manifold[] = []
    for (const obj of m) {
        if (Array.isArray(obj)) objs.push(...dd(obj))
        else if (typeof m !== 'undefined') objs.push(obj)
    }
    return objs
}

function ensureCCW(p: Vec2[]) {
    const ba = new Vector2(p[0][0] - p[1][0], p[0][1] - p[1][1])
    const bc = new Vector2(p[2][0] - p[1][0], p[2][1] - p[1][1])
    if (ba.cross(bc) > 0) p.reverse()
    return p
}

function addVertices(arr: number[][], mesh: Mesh) {
    if (mesh.numProp != 3) throw new Error('Only numProp==3 is supported')
    for (let i = 0; i < mesh.vertProperties.length; i += 3) {
        arr.push([mesh.vertProperties[i],
                  mesh.vertProperties[i+1],
                  mesh.vertProperties[i+2]])
    }
    return arr
}

function toPolygons(mesh: Mesh) {
    const vertices = addVertices([], mesh)
    const tris = mesh.triVerts
    const polygons: { vertices: number[][] }[] = []
    for (let i = 0; i < tris.length; i+=3) {
        polygons.push({
            "vertices": [vertices[tris[i]], vertices[tris[i+1]], vertices[tris[i+2]]]
        })
    }
    return polygons
}

function toDegrees(rad: number) {
    return rad * (180/Math.PI);
}

/** For a set of triangles, fill the interior region by turning each triangle into a
 * quadrilateral that touches the center.
 */
function fillInsides(faces: number[][][]) {
    const vectors = faces.flat().map(v => new Vector2(v[0], v[1]));
    const center = vectors.reduce((prev, current) => prev.add(current), new Vector2(0, 0))
        .divideScalar(vectors.length);
    const centerVert = center.toArray();
    faces.forEach((verts, i) => {
        const distances = verts.map(v => -new Vector2(v[0], v[1]).sub(center).length())
        const furthest = distances.indexOf([...distances].sort()[0])
        if (furthest == 0) faces[i] = [verts[0], verts[1], centerVert, verts[2]]
        else if (furthest == 1) faces[i] = [verts[0], verts[1], verts[2], centerVert]
        else if (furthest == 2) faces[i] = [verts[0], centerVert, verts[1], verts[2]]
    })
}

export const createModeling = (manifold: ManifoldStatic) => ({
    manifold,
    booleans: {
        subtract(...objs: Manifold[]) {
            return manifold.difference(dd(objs))
        },
        union(...objs: Manifold[]) {
            return manifold.union(dd(objs))
        },
        intersection(...objs: Manifold[]) {
            return manifold.intersection(dd(objs))
        },
    },
    colors: {
        colorize(_color, obj: Manifold) {
            return d(obj)
        }
    },
    extrusions: {
        project(opts: any, objs: Manifold[]) {
            const vectors: number[][] = []
            const meshes = dd(objs).map(obj => {
                const epsilon = 0.01
                // @ts-ignore
                if (opts.cut) obj = obj.trimByPlane([0,0,1], -epsilon).trimByPlane([0,0,-1], -epsilon)
                const mesh = obj.getMesh()
                addVertices(vectors, mesh)
                return mesh
            })
            const vertices: Vec2[] = vectors.map(v => [v[0], v[1]])

            if (opts.cut) {
                const faces = meshes.flatMap(m => {
                    const f = []
                    const t = m.triVerts
                    for (let i = 0; i < t.length; i+=3) {
                        f.push([vertices[t[i]], vertices[t[i+1]], vertices[t[i+2]]])
                    }
                    return f
                })
                fillInsides(faces) // NOTE: This goes against the exepcted behavior of cut(). In JSCAD, the inside is not filled.
                                   // However, it is nice to do this for the dactyl bottom plate.
                const flatFaces = faces.flat()
                // @ts-ignore
                const tris = manifold.triangulate(faces) as number[][]
                return tris.map(v => ensureCCW(v.map(i => flatFaces[i])))
            }

            // @ts-ignore
            const tris = manifold.triangulate(vertices) as number[][]
            return tris.map(v => ensureCCW(v.map(i => vertices[i])))
        },
        extrudeLinear(opts: any, polys: Polygons[]) {
            return manifold.extrude(polys[0], opts.height)
        }
    },
    hulls: {
        hull(objs: Manifold[]) {
            // Collect the meshes of the hulled objects
            // And compute the total number of vertices*3
            let arrLen = 0
            const meshes = dd(objs).map(obj => {
                const mesh = obj.getMesh()
                arrLen += mesh.vertProperties.length
                return mesh
            })

            // Collect all vertices so they can be used in the convex hull.
            // Also collect them in the Float32Array vertProperties, so that
            // the generated mesh has access to all of the vertices.
            const vectors: number[][] = []
            const vertProperties = new Float32Array(arrLen)
            let pos = 0
            for (const mesh of meshes) {
                addVertices(vectors, mesh)
                vertProperties.set(mesh.vertProperties, pos)
                pos += mesh.vertProperties.length
            }

            // Perform the Convex Hull!
            const faces = quickhull(vectors)

            // Set the mesh's faces from the faces given by the hull operation.
            const triVerts = new Uint32Array(faces.length * 3)
            faces.forEach((f, i) => triVerts.set(f, i*3))

            return new manifold.Manifold(new manifold.Mesh({
                numProp: 3, vertProperties, triVerts
            }))
        }
    },
    geometries: {
        geom3: {
            toPolygons(obj: Manifold) {
                return toPolygons(d(obj).getMesh())
            }
        }
    },
    maths: {
        mat4: {
            create() {
                return new Matrix4()
            },
            fromRotation(out: Matrix4, rad: number, axis: Vec3) {
                return out.makeRotationAxis(new Vector3(...axis), rad)
            }
        }
    },
    measurements: {
        measureVolume(m: Manifold) {
            return d(m).getProperties().volume
        }
    },
    primitives: {
        cuboid(opts: any) {
            return manifold.cube(opts.size, true)
        },
        cylinder(opts: any) {
            return manifold.cylinder(opts.height, opts.radius, -1, 0, true)
        },
        cylinderElliptic(opts: any) {
            return manifold.cylinder(opts.height, opts.startRadius[0], opts.endRadius[0], 0, true)
        },
        sphere(opts: any) {
            return manifold.sphere(opts.radius, 0)
        },
        polygon(opts: any) {
            // Assume the polygon is convex! The first three points will be a,b,c respectively.
            const p = [...opts.points]
            return ensureCCW(p)
        },
        importSTL(url: string) {
            const cached = stlCache.get(url)
            if (!cached) {
                // STL not loaded yet — return a placeholder cube and warn
                console.warn(`STL not preloaded: ${url}, using placeholder`)
                return manifold.cube([1, 1, 1], true)
            }
            return cached
        },
        cherryMXSTL() {
            const cached = stlCache.get(CHERRY_MX_STL)
            if (!cached) {
                console.warn('Cherry MX STL not preloaded, using placeholder')
                return manifold.cube([15.6, 15.6, 11.6], true)
            }
            return cached
        }
    },
    transforms: {
        translate(translation: Vec3, obj: Manifold) {
            return d(obj).translate(translation)
        },
        mirror({ normal }, obj: Manifold) {
            // @ts-ignore
            return d(obj).mirror(normal)
        },
        rotateX(rad: number, obj: Manifold) {
            return d(obj).rotate([toDegrees(rad), 0, 0])
        },
        rotateY(rad: number, obj: Manifold) {
            return d(obj).rotate([0, toDegrees(rad), 0])
        },
        rotateZ(rad: number, obj: Manifold) {
            return d(obj).rotate([0, 0, toDegrees(rad)])
        },
        transform(mat: Matrix4, obj: Manifold) {
            return d(obj).transform(mat.elements as any)
        }
    }
})

export type Modeling = ReturnType<typeof createModeling>

export function serializeMesh(m: Manifold) {
    let volume = 0
    let mesh
    if (m.vertices) {
        mesh = { vertProperties: m.vertices, triVerts: m.faces }
    } else {
        volume = m.getProperties().volume
        mesh = m.getMesh()
    }

    const cb = new Vector3();
    const ab = new Vector3();
    const normal = []

    const pos = []
    for (let i = 0; i < mesh.vertProperties.length; i += 3) {
        pos.push(new Vector3().fromArray(mesh.vertProperties, i))
    }

    const normals = new Float32Array(mesh.triVerts.length*3)
    const vertices = new Float32Array(mesh.triVerts.length*3)

    let i = 0;
    for (let tri = 0; tri < mesh.triVerts.length; tri += 3) {
        const vA = pos[mesh.triVerts[tri+0]],
              vB = pos[mesh.triVerts[tri+1]],
              vC = pos[mesh.triVerts[tri+2]];
        cb.subVectors(vC, vB);
        ab.subVectors(vA, vB);
        cb.cross(ab).normalize().toArray(normal)

        vertices.set(vA.toArray(), i)
        vertices.set(vB.toArray(), i+3)
        vertices.set(vC.toArray(), i+6)
        normals.set(normal, i)
        normals.set(normal, i+3)
        normals.set(normal, i+6)
        i += 9;
    }

    return { vertices, normals, volume }
}
