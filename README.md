<p>
  <img src="./logo.svg" alt="rsynxiety" height="80">
</p>

# rsynxiety

Copying terabytes of video files between hard drives requires care. Transfers can fail halfway through. A bad sector can corrupt a file during transit.

`rsynxiety` is a Node.js CLI wrapper for rsync. It defaults to strict verification settings to verify the files.

## Installation

We use pnpm.

```bash
git clone <repository>
cd rsynxiety
pnpm install
pnpm link --global
```

## Usage

Run the tool without arguments to open the interactive wizard.

```bash
rsynxiety
```

Or pass the paths directly.

```bash
rsynxiety /Volumes/SourceDrive /Volumes/DestDrive
```

Use `--canary .drive_id` to strictly require a sentinel file on the destination. Use `--skip-hash` to skip the final xxHash verification.

## Architecture and design decisions

Hard drives fail. Cables come loose. `rsynxiety` handles these interruptions.

### Partial transfers

When a transfer drops midway, you need a way to resume it. Rsync provides two common flags for this. They are `--append-verify` and `--partial-dir`.

We use `--partial-dir`. When an initial transfer breaks, this flag keeps the incomplete file hidden in a dot folder. A subsequent run resumes the file from this isolated directory and only moves it into the final destination when it completes. 

Using `--append-verify` appends data directly to the incomplete file at the destination path and verifies the old data matches. We avoid this flag. It leaves partial files sitting in the open where other programs might try to read them. It also skips files entirely if the destination size matches the source size, even if the bytes are different. This can cause silent data loss on interrupted pre-allocated files.

### Hardware cache flushing

Operating systems hold data in memory caches to speed up apparent write times. If a script reads a file right after writing it, the kernel serves the file from RAM. This can mask disk controller errors.

We run the `sync` command before we hash files. This forces the OS to flush all pending buffers to the physical storage media. When we calculate the final checksum, we read the actual bits off the disk hardware to verify the write succeeded.

### Post-transfer validation

Many workflows use `rsync -c` to verify data. It calculates checksums for all files on both sides to decide what to transfer. It works well over slow networks.

For local transfers, `rsync -c` reads the source and destination simultaneously. This single-threaded approach thrashes mechanical hard drives. 

We use `xxh128sum` after the transfer completes. The xxHash family runs fast enough to fully saturate modern storage connections. We generate a list of hashes at the source and verify them at the destination. It validates the copy faster than `rsync -c` and catches corruption that size and time checks miss.
