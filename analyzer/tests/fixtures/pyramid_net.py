import torch.nn as nn


class PyramidNet(nn.Module):
    """Patterns from pix2pixHD-style code: list-built Sequential, list of tensors, aliases."""

    def __init__(self):
        super().__init__()
        layers = [nn.Conv2d(3, 4, 1), nn.ReLU()]
        layers += [nn.Conv2d(4, 4, 1)]
        self.body = nn.Sequential(*layers)
        self.down = nn.AvgPool2d(2)
        self.head = self.build_head()

    def build_head(self):
        return nn.Sequential(nn.Conv2d(4, 2, 1))

    def forward(self, x):
        pyramid = [x]
        for _ in range(1):
            pyramid.append(self.down(pyramid[-1]))
        coarse = self.body(pyramid[-1])
        head = self.head
        return head(coarse)
