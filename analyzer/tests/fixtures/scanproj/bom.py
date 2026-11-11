import torch.nn as nn


class WithBom(nn.Module):
    def forward(self, x):
        return x
